# node-redis-streams <!-- omit in toc -->

Redis Streams Package for Node.js/Typescript with full consumer group recovery

The goal of this package to bring many Kafka (and `kafkajs`) like features to Redis Streams.

- [Documentation](#documentation)
  - [Processing Records](#processing-records)
    - [Example](#example)
  - [Class Methods](#class-methods)
    - [StartConsuming](#startconsuming)
    - [StopConsuming](#stopconsuming)
  - [ConsumerOptions](#consumeroptions)
    - [consumerName](#consumername)
    - [groupName](#groupname)
    - [readItems](#readitems)
    - [recordHandler](#recordhandler)
    - [errorHandler](#errorhandler)
    - [batchHandler](#batchhandler)
    - [redisClient](#redisclient)
    - [streamName](#streamname)
    - [blockIntervalMS](#blockintervalms)
    - [checkAbandonedIntervalMS](#checkabandonedintervalms)
    - [disableAbandonedCheck](#disableabandonedcheck)
  - [Consumer Group Reclaiming - 'Recovering from permanent failures'](#consumer-group-reclaiming---recovering-from-permanent-failures)
  - [Best Practices](#best-practices)
    - [Processing long running records](#processing-long-running-records)
    - [Processing multiple streams on the same server/pod](#processing-multiple-streams-on-the-same-serverpod)

## Documentation

### Processing Records

Records will be processed sequentially, then all record IDs will be `XACK`'d at the end of the batch. If an error is throw during the batch, all previously processed records will be acknowledge, and the batch will stop processing.

This has been chosen as an alternative to calling `XACK` after every record is processed to minimize calls to streams, optimize for scalability, and follow in `kafkajs`'s logic for handling record consuming.

#### Example

The following is a simple example of using the package:

```js
const nrs = require('node-redis-streams')
const Redis = require('ioredis')

const reader = new Redis()

const streamConsumer = new nrs.Consumer({
  consumerName: 'example_consumer',
  groupName: 'example_group',
  readItems: 50,
  recordHandler: async (record) => {
    console.log('Got record', record)
    if (record.reclaimed) {
      console.log('this was a reclaimed record!')
    }
  },
  errorHandler: async (record) => {
    console.log('ERROR DETECTED FOR RECORD', record)
  },
  redisClient: reader,
  streamName: 'example_stream',
  blockIntervalMS: 1000,
  checkAbandonedMS: 2000
})
time.StartConsuming()
```

Diving into the package, we can see how the previous configuration applies to the Redis command:

```js
redisClient.xreadgroup('GROUP', this.groupName, this.consumerName, 'COUNT', this.readItems, 'BLOCK', this.blockIntervalMS, 'STREAMS', this.streamName, '>')
```

This means we will join the group `groupName` under the consumer name `consumerName`, pulling a maximum of `readItems` records. We will block for up to `blockIntervalMS` milliseconds, and being the next `XREADGROUP` immediately after.

### Class Methods

#### StartConsuming

This will begin consuming records by starting the two loops (processor and reclaim).

#### StopConsuming

This will gracefully stop consuming records. It will finish processing what ever records have currently been pulled, and prevent any future records from being pulled from either the normal loop or the reclaim loop.

If you stop the package/IORedis instance without calling this method, you may end up with processed but unacknowledged messages, or with abandoned messages that will need to be reclaimed.

### ConsumerOptions

#### consumerName

The name of the consumer instance.

Using the hostname of the server/container is typically appropriate for this:

```js
const os = require('os')
// ...
const streamConsumer = new nrs.Consumer({
  consumerName: os.hostname(),
  // ...
```

#### groupName

The name of the consumer group the consumer will be joining.

#### readItems

The number of items to read for each `XREADGROUP` call. This is shared between the normal record processor, as well as the reclaimed processor.

#### recordHandler

`recordHandler` is fired for every record that is returned, it expects an unhandled Promise to be returned (i.e. it needs to handle an error should one be thrown).

When an error is thrown, it will immediately `XACK` all of the previously processed records, discontinue processing any more, and call the `errorHandler` function on the record that threw an error.

#### errorHandler

`errorHandler` is fired when `recordHandler` throws an error. This provides a built-in opportunity to perform custom logic like inserting into a DLQ (or Dead-letter stream if you will), log appropriately, and more.

#### batchHandler

`batchHandler` is fired before `recordHandler` (if both used), and is used to process the entire batch at once.

This is considered advanced usage of this package, as there is no fail-safe record acknowledgement handled for you in `batchHandler`, you are in charge of calling `XACK` on acknowledged records. There is no harm in calling `XACK` multiple times on the same record other than unnecessary calls to Redis, so technically using `batchHandler` and `recordHandler`/`errorHandler` together shouldn't cause major issues, but it would be wise to avoid.

The following is an example of managing calls to `XACK` within the `batchHandler` function while also ensuring all successfully processed records get acknowledged in the event of a record processing error:

```js
const nrs = require('node-redis-streams')
const Redis = require('ioredis')

const reader = new Redis()

const streamConsumer = new nrs.Consumer({
  consumerName: 'example_consumer',
  groupName: 'example_group',
  readItems: 50,
  batchHandler: async (records) => {
    const ids = []
    try {
      for (const record of records) {
        // Some logic...

        // Pushing to this array should be last to ensure we only push successfully processed records
        ids.push(record.recordID)
      }
    } catch (error) {
      // Error logic...
    }
    // XACK all of the successfully processed messages
    redisClient.XACK('example_stream', 'example_group', ...ids)
  }
  redisClient: reader,
  streamName: 'example_stream',
  blockIntervalMS: 1000,
  checkAbandonedMS: 2000
})
time.StartConsuming()
```

#### redisClient

An `ioredis` redis client.

**Note:** using a client that never performs a write is required here, as Redis Streams cannot share a streams connection with a client that writes. You can to another read-only client by calling:
```js
readClient = redisClient.duplicate()
```

#### streamName

The name of the Stream to consume.

#### blockIntervalMS

The time in milliseconds to `BLOCK` when performing an `XREADGROUP`.

#### checkAbandonedIntervalMS

The time in milliseconds to wait before calling `XPENDING` again. It will also ensure that a record has been pending for at least this time before performing `XCLAIM`.

It is important to choose this number carefully, as if your batch takes longer than this to process, and you only call `XACK` at the end of the batch, then this can detect falsely abandoned records. See the [Best Practices](#best-practices) section for more.


#### disableAbandonedCheck

Setting this to true will disable the second loop to check for abandoned messages from other consumers in the group. This will cause `checkAbandonedIntervalMS` to have no effect. If you disable this make sure you know exactly what you are doing as losing abandoned messages is dangerous.

If you want to have quick checks for abandoned messages, but only a few of your consumers actually doing those checks, this is a useful feature.

### Consumer Group Reclaiming - 'Recovering from permanent failures'

One of the nicest parts of Kafka is that the consumer groups manage when one consumer dies and never returns. As for Redis Streams, this is something we must implement ourselves using the various commands.

`node-redis-streams` handles this for you using the `checkAbandonedMS` option.

There is a second polling interval that checks purely for `XPENDING` records that have been pending longer than the `checkAbandonedMS` (in milliseconds). When a record has passed that number, the consumer will claim those records and process them using the same logic as normal records.

The reclaim loop will use the same `recordHandler` and `errorHandler` methods defined in the `Consumer` initialization, or the same `batchHandler`.

When a record has been claimed from another consumer, it will have the additional property `reclaimed: true` on the `record` object. The `reclaimed` key will be `false` otherwise.

_Note: this will overwrite any `reclaimed` key you may have in your original record, so best to avoid it or name it something else._

If you require custom logic when a record is reclaimed from a (potentially) dead consumer, you can perform a simple check such as:

```js
if (record.reclaimed) {
  // Your custom logic
}
```

### Best Practices

#### Processing long running records

If individual records take a long time to process, the abandoned record reclaimer might detect falsely abandoned records. Solutions would include:

- Reducing the number of `readItems` pulled
- Increasing the number of consumers (with unique consumer names, could run multiple on the same server/pod with different names)
- Increasing the `checkIntervalMS`
- Calling `XACK` after each individual record is processed by using `batchHandler`

#### Processing multiple streams on the same server/pod

This package can be instantiated multiple times to handle the processing of multiple streams within the same process.

You could even run multiple consumers of the same stream, as long as you instantiate each `Consumer` with a different `consumerName`.
