# node-redis-streams <!-- omit in toc -->

Redis Streams Library for Node.js/Typescript with full consumer group recovery

The goal of this library to bring many Kafka (and `kafkajs`) like features to Redis Streams.

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
  - [redisClient](#redisclient)
  - [streamName](#streamname)
  - [blockIntervalMS](#blockintervalms)
  - [checkAbandonedIntervalMS](#checkabandonedintervalms)
- [Consumer Group Reclaiming - 'Recovering from permanent failures'](#consumer-group-reclaiming---recovering-from-permanent-failures)

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

`errorHandler` is fired when a record within a pulled group of records throws an error. This provides a built-in opportunity to perform custom logic like inserting into a DLQ (or Dead-letter stream if you will), log appropriately, and more.

#### redisClient

A `ioredis` redis client.

**Note:** using a client that never performs a write is required here, as redis cannot shared a streams connection with a client that writes. You can to another read-only client by calling:
```js
readClient = redisClient.duplicate()
```

#### streamName

The name of the Stream to consume.

#### blockIntervalMS

The time in milliseconds to `BLOCK` when performing an `XREADGROUP`.

#### checkAbandonedIntervalMS

The time in milliseconds to wait before calling `XPENDING` again. It will also ensure that a record has been pending for at least this time before performing `XCLAIM`.

### Consumer Group Reclaiming - 'Recovering from permanent failures'

One of the nicest parts of Kafka is that the consumer groups manage when one consumer dies and never returns. As for Redis Streams, this is something we must implement ourselves using the various commands.

`node-redis-streams` handles this for you using the `checkAbandonedMS` option.

There is a second polling interval that checks purely for `XPENDING` records that have been pending longer than the `checkAbandonedMS` (in milliseconds). When a record has passed that number, the consumer will claim those records and process them using the same logic as normal records.

The reclaim loop will use the same `recordHandler` and `errorHandler` methods defined in the `Consumer` initialization.

When a record has been claimed from another consumer, it will have the additional property `reclaimed: true` on the `record` object. The `reclaimed` key will be `undefined` otherwise, as we opt to only add it in when necessary for speed of processing.

_Note: this will overwrite any `reclaimed` key you may have in your original record, so best to avoid it or name it something else._

If you require custom logic when a record is reclaimed from a (potentially) dead consumer, you can perform a simple check such as:

```js
if (record.reclaimed) {
  // Your custom logic
}
```
