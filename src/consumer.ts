import IORedis from "ioredis"

import { ConsumerOptions, StreamRecord } from './types/main'

export default class consumer {
  readLock = false
  exitLoop = false
  abandonLock = false
  checkAbandonedInterval: NodeJS.Timeout | null = null
  checkAbandonedMS: number
  redisClient: IORedis.Redis
  consumerName: string
  groupName: string
  readItems: number
  blockIntervalMS: number
  streamName: string
  // See `types/main.d.ts` for what these do
  recordHandler: (streamRecord: StreamRecord) => Promise<void>
  errorHandler: (streamRecord: StreamRecord) => Promise<void>

  constructor (options: ConsumerOptions) {
    this.redisClient = options.redisClient
    this.checkAbandonedMS = options.checkAbandonedMS || 1000
    this.consumerName = options.consumerName
    this.groupName = options.groupName
    this.readItems = options.readItems
    this.blockIntervalMS = options.blockIntervalMS || 0
    this.streamName = options.streamName
    this.recordHandler = options.recordHandler
    this.errorHandler = options.errorHandler
  }

  /**
   * Builds {key: value} pairs out of the flat list obtained from stream
   */
  buildKVPairs (itemArray: any): any {
    const retObj: any = {}
    retObj.recordID = itemArray[0]
    for (let i = 0; i < itemArray[1].length; i += 2) {
      retObj[itemArray[1][i]] = itemArray[1][i + 1]
    }
    return retObj
  }

  async ackIDs (ids: string[]) {
    if (ids.length === 0) return
    await this.redisClient.xack(this.streamName, this.groupName, ...ids)
  }

  async ackID (id: any) {
    await this.redisClient.xack(this.streamName, this.groupName, id)
  }

  async readGroup () {
    this.readLock = true
    const stream = await this.redisClient.xreadgroup('GROUP', this.groupName, this.consumerName, 'COUNT', this.readItems, 'BLOCK', this.blockIntervalMS, 'STREAMS', this.streamName, '>')
    if (stream !== null && stream.length > 0) {
      const items = stream[0][1]
      const ids = []
      let handledError = false
      for (const item of items) {
        const record: StreamRecord = this.buildKVPairs(item)
        ids.push(record.recordID)
        try {
          await this.recordHandler(record)
        } catch (error) { // One of the items caused an error, ack everything we have and exit
          handledError = true
          await this.ackIDs(ids)
          await this.errorHandler(record)
        }
      }
      if (!handledError) { // If we didn't exit from an error, ack the ids
        await this.ackIDs(ids)
      }
      this.readLock = false
    } else {
      this.readLock = false
    }
    setTimeout(() => { // So the call stack clears
      if (!this.exitLoop) {
        this.readGroup()
      }
    }, 0)
  }

  async checkAbandoned () {
    this.abandonLock = true
    const stream = await this.redisClient.xpending(this.streamName, this.groupName, '-', '+', this.readItems)
    if (stream !== null && stream.length > 1) {
      const recoveryConsumers: any = {} // consumerName: ['ids']
      await Promise.all(stream.map(async (record: any[]) => {
        const id = record[0]
        const consumer = record[1]
        const idleTime: number = record[2]
        const deliveryAttempts = record[3] // we may want to use this later for a DLQ (or DLS I guess)
        if (idleTime > this.checkAbandonedMS) {
          if (!recoveryConsumers[consumer]) {
            recoveryConsumers[consumer] = []
          }
          recoveryConsumers[consumer].push(id)
        }
      }))
      await Promise.all(Object.keys(recoveryConsumers).map(async (consumer) => {
        const claimed = await this.redisClient.xclaim(this.streamName, this.groupName, consumer, this.checkAbandonedMS, ...recoveryConsumers[consumer])
        if (claimed !== null && claimed.length > 0) {
          const items = claimed[0][1]
          const ids = []
          let handledError = false
          for (const item of items) {
            const record: StreamRecord = this.buildKVPairs(item)
            ids.push(record.recordID)
            try {
              await this.recordHandler(record)
            } catch (error) { // One of the items caused an error, ack everything we have and exit
              handledError = true
              await this.ackIDs(ids)
              await this.errorHandler(record)
            }
          }
          if (!handledError) { // If we didn't exit from an error, ack the ids
            await this.ackIDs(ids)
          }
        }
      }))
      this.abandonLock = false
    } else {
      this.abandonLock = false
    }
  }

  async StartConsuming() {
    setTimeout(() => {
      this.readGroup()
    }, 0)
    this.checkAbandonedInterval = setInterval(() => {
      // this.checkAbandoned()
    }, this.checkAbandonedMS)
  }

  /**
   * Gracefully stop consuming
   */
  async StopConsuming() {
    this.exitLoop = true // stop reading items
    clearInterval(this.checkAbandonedInterval!) // Stop abandoned check
    await new Promise<void>((resolve) => { // Make sure we ack everything we've set to process
      const inter = setInterval(() => {
        if (!this.readLock && !this.abandonLock) {
          resolve()
          clearInterval(inter)
        }
      }, 100)
    })
    await this.redisClient.quit() // Disconnect redis (wait for current replies)
  }
}
