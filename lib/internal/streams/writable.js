// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

const {
  ArrayPrototypeSlice,
  Error,
  FunctionPrototypeSymbolHasInstance,
  ObjectDefineProperty,
  ObjectDefineProperties,
  ObjectSetPrototypeOf,
  StringPrototypeToLowerCase,
  Symbol,
  SymbolHasInstance,
} = primordials;

module.exports = Writable;
Writable.WritableState = WritableState;

const EE = require('events');
const Stream = require('internal/streams/legacy').Stream;
const { Buffer } = require('buffer');
const destroyImpl = require('internal/streams/destroy');

const {
  addAbortSignal,
} = require('internal/streams/add-abort-signal');

const {
  getHighWaterMark,
  getDefaultHighWaterMark
} = require('internal/streams/state');
const {
  ERR_INVALID_ARG_TYPE,
  ERR_METHOD_NOT_IMPLEMENTED,
  ERR_MULTIPLE_CALLBACK,
  ERR_STREAM_CANNOT_PIPE,
  ERR_STREAM_DESTROYED,
  ERR_STREAM_ALREADY_FINISHED,
  ERR_STREAM_NULL_VALUES,
  ERR_STREAM_WRITE_AFTER_END,
  ERR_UNKNOWN_ENCODING
} = require('internal/errors').codes;

const { errorOrDestroy } = destroyImpl;

ObjectSetPrototypeOf(Writable.prototype, Stream.prototype);
ObjectSetPrototypeOf(Writable, Stream);

function nop() {}

const kOnFinished = Symbol('kOnFinished');

function WritableState(options, stream, isDuplex) {
  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream,
  // e.g. options.readableObjectMode vs. options.writableObjectMode, etc.
  if (typeof isDuplex !== 'boolean')
    isDuplex = stream instanceof Stream.Duplex;

  // Object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!(options && options.objectMode);

  if (isDuplex)
    this.objectMode = this.objectMode ||
      !!(options && options.writableObjectMode);

  // The point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write().
  this.highWaterMark = options ?
    getHighWaterMark(this, options, 'writableHighWaterMark', isDuplex) :
    getDefaultHighWaterMark(false);

  // if _final has been called.
  this.finalCalled = false;

  // drain event flag.
  this.needDrain = false;
  // At the start of calling end()
  this.ending = false;
  // When end() has been called, and returned.
  this.ended = false;
  // When 'finish' is emitted.
  this.finished = false;

  // Has it been destroyed
  this.destroyed = false;

  // Should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  const noDecode = !!(options && options.decodeStrings === false);
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = (options && options.defaultEncoding) || 'utf8';

  // Not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  // 最关键一点，它会和HighWaterMark比较
  this.length = 0;

  // A flag to see when we're in the middle of a write.
  // 正在写入 -- 一般写入时，不在进行其它写入操作
  this.writing = false;

  // When true all writes will be buffered until .uncork() call.
  this.corked = 0;

  // A flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  // confuse
  this.sync = true;

  // A flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // The callback that's passed to _write(chunk, cb).
  this.onwrite = onwrite.bind(undefined, stream);

  // The callback that the user supplies to write(chunk, encoding, cb).
  this.writecb = null;

  // The amount that is being written when _write is called.
  this.writelen = 0;

  // Storage for data passed to the afterWrite() callback in case of
  // synchronous _write() completion.
  this.afterWriteTickInfo = null;

  // 重置本“流”的buffer
  resetBuffer(this);

  // Number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted.
  this.pendingcb = 0;

  // Stream is still being constructed and cannot be
  // destroyed until construction finished or failed.
  // Async construction is opt in, therefore we start as
  // constructed.
  this.constructed = true;

  // Emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams.
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again.
  this.errorEmitted = false;

  // Should close be emitted on destroy. Defaults to true.
  this.emitClose = !options || options.emitClose !== false;

  // Should .destroy() be called after 'finish' (and potentially 'end').
  this.autoDestroy = !options || options.autoDestroy !== false;

  // Indicates whether the stream has errored. When true all write() calls
  // should return false. This is needed since when autoDestroy
  // is disabled we need a way to tell whether the stream has failed.
  this.errored = null;

  // Indicates whether the stream has finished destroying.
  this.closed = false;

  // True if close has been emitted or would have been emitted
  // depending on emitClose.
  this.closeEmitted = false;

  this[kOnFinished] = [];
}

function resetBuffer(state) {
  state.buffered = [];
  state.bufferedIndex = 0;
  // confuse暂时不知道什么用
  state.allBuffers = true;
  // confuse暂时不知道什么用
  state.allNoop = true;
}

WritableState.prototype.getBuffer = function getBuffer() {
  return ArrayPrototypeSlice(this.buffered, this.bufferedIndex);
};

ObjectDefineProperty(WritableState.prototype, 'bufferedRequestCount', {
  get() {
    return this.buffered.length - this.bufferedIndex;
  }
});

function Writable(options) {
  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.

  // Checking for a Stream.Duplex instance is faster here instead of inside
  // the WritableState constructor, at least with V8 6.5.
  const isDuplex = (this instanceof Stream.Duplex);
  // 【x instance of 函数 】- 被重写了，具体不祥，但目的和instance of差不多
  if (!isDuplex && !FunctionPrototypeSymbolHasInstance(Writable, this))
    return new Writable(options);

  this._writableState = new WritableState(options, this, isDuplex);
  // 这种写法可外部配置，如果不配置，也可以“子类”实现
  // 但前缀为下划线的一般不是由用户配置，文档也有说明
  if (options) {
    if (typeof options.write === 'function')
      this._write = options.write;

    if (typeof options.writev === 'function')
      this._writev = options.writev;

    if (typeof options.destroy === 'function')
      this._destroy = options.destroy;

    if (typeof options.final === 'function')
      this._final = options.final;

    if (typeof options.construct === 'function')
      this._construct = options.construct;

    if (options.signal)
      addAbortSignal(options.signal, this);
  }
  // 拷贝属性
  Stream.call(this, options);
  
  // 执行的前提: _construct被初始化为function
  // fs/streams.js下有具体实现
  destroyImpl.construct(this, () => {
    const state = this._writableState;

    if (!state.writing) {
      clearBuffer(this, state);
    }

    finishMaybe(this, state);
  });
}

ObjectDefineProperty(Writable, SymbolHasInstance, {
  value: function(object) {
    if (FunctionPrototypeSymbolHasInstance(this, object)) return true;
    if (this !== Writable) return false;

    return object && object._writableState instanceof WritableState;
  },
});

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function() {
  errorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE());
};

function _write(stream, chunk, encoding, cb) {
  const state = stream._writableState;

  // 对应使用方式_write(stream, chunk[, encoding][, callback])
  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = state.defaultEncoding;
  } else {
    if (!encoding)
      encoding = state.defaultEncoding;
    else if (encoding !== 'buffer' && !Buffer.isEncoding(encoding))
      throw new ERR_UNKNOWN_ENCODING(encoding);
    if (typeof cb !== 'function')
      cb = nop;
  }
  // 对 支持类型 验证+处理
  if (chunk === null) {
    throw new ERR_STREAM_NULL_VALUES();
  } else if (!state.objectMode) {
    if (typeof chunk === 'string') {
      if (state.decodeStrings !== false) {
        chunk = Buffer.from(chunk, encoding);
        encoding = 'buffer';
      }
    } else if (chunk instanceof Buffer) {
      encoding = 'buffer';
    } else if (Stream._isUint8Array(chunk)) {
      chunk = Stream._uint8ArrayToBuffer(chunk);
      encoding = 'buffer';
    } else {
      throw new ERR_INVALID_ARG_TYPE(
        'chunk', ['string', 'Buffer', 'Uint8Array'], chunk);
    }
  }
  // 检查是否有相关错误
  let err;
  if (state.ending) {
    err = new ERR_STREAM_WRITE_AFTER_END();
  } else if (state.destroyed) {
    err = new ERR_STREAM_DESTROYED('write');
  }

  if (err) {
    // 向回调 异步 传入错误信息
    process.nextTick(cb, err);
    errorOrDestroy(stream, err, true);
    return err;
  }
  // confuse "finish"事件发射之前必须为0，展示的是“用户填写的write回调个数”
  state.pendingcb++;
  // 没有直接调用原型上的writeOrBuffer而是调用公共函数writeOrBuffer
  return writeOrBuffer(stream, state, chunk, encoding, cb);
}

Writable.prototype.write = function(chunk, encoding, cb) {
  // 没有直接调用原型上的_write而是调用公共函数_write
  return _write(this, chunk, encoding, cb) === true;
};

// 塞住：形象理解，加锁，
Writable.prototype.cork = function() {
  this._writableState.corked++;
};

// 去塞：形象理解，开锁，直到所有锁打开，开始清缓存
Writable.prototype.uncork = function() {
  const state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing)
      clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string')
    encoding = StringPrototypeToLowerCase(encoding);
  if (!Buffer.isEncoding(encoding))
    throw new ERR_UNKNOWN_ENCODING(encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

// If we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
// 顾名思义：写入或者缓冲
function writeOrBuffer(stream, state, chunk, encoding, callback) {
  const len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  // stream._write resets state.length
  const ret = state.length < state.highWaterMark;
  // We must ensure that previous needDrain will not be reset to false.
  if (!ret)
    state.needDrain = true;
  // 往buffer注水的几种情况：正在写入、塞住、错误？、初始化未完成
  // 由此可以想象一种情况，如果没有缓冲，那么只能等待上一次文件写完，才能下一次
  // 有了缓冲再加上buffer可以同时写入的加持，速度得到了提升
  if (state.writing || state.corked || state.errored || !state.constructed) {
    state.buffered.push({ chunk, encoding, callback });
    if (state.allBuffers && encoding !== 'buffer') {
      state.allBuffers = false;
    }
    if (state.allNoop && callback !== nop) {
      state.allNoop = false;
    }
  } else {
    // 否则直接往文件里写；如果不在drain事件之前停止写入，buffer可能会一直增加，直到内存达到极限
    state.writelen = len;
    state.writecb = callback;
    state.writing = true;
    state.sync = true;
    stream._write(chunk, encoding, state.onwrite);//回调里有clearBuffer
    state.sync = false;
  }

  // Return false if errored or destroyed in order to break
  // any synchronous while(stream.write(data)) loops.
  return ret && !state.errored && !state.destroyed;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (state.destroyed)
    state.onwrite(new ERR_STREAM_DESTROYED('write'));
  else if (writev)
    stream._writev(chunk, state.onwrite);
  else
    stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, er, cb) {
  --state.pendingcb;

  cb(er);
  // Ensure callbacks are invoked even when autoDestroy is
  // not enabled. Passing `er` here doesn't make sense since
  // it's related to one specific write, not to the buffered
  // writes.
  errorBuffer(state);
  // This can emit error, but error must always follow cb.
  errorOrDestroy(stream, er);
}

function onwrite(stream, er) {
  const state = stream._writableState;
  const sync = state.sync;
  const cb = state.writecb;

  if (typeof cb !== 'function') {
    errorOrDestroy(stream, new ERR_MULTIPLE_CALLBACK());
    return;
  }

  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;

  if (er) {
    // Avoid V8 leak, https://github.com/nodejs/node/pull/34103#issuecomment-652002364
    er.stack; // eslint-disable-line no-unused-expressions

    if (!state.errored) {
      state.errored = er;
    }

    // In case of duplex streams we need to notify the readable side of the
    // error.
    if (stream._readableState && !stream._readableState.errored) {
      stream._readableState.errored = er;
    }

    if (sync) {
      process.nextTick(onwriteError, stream, state, er, cb);
    } else {
      onwriteError(stream, state, er, cb);
    }
  } else {
    if (state.buffered.length > state.bufferedIndex) {
      clearBuffer(stream, state);
    }

    if (sync) {
      // It is a common case that the callback passed to .write() is always
      // the same. In that case, we do not schedule a new nextTick(), but
      // rather just increase a counter, to improve performance and avoid
      // memory allocations.
      if (state.afterWriteTickInfo !== null &&
          state.afterWriteTickInfo.cb === cb) {
        state.afterWriteTickInfo.count++;
      } else {
        state.afterWriteTickInfo = { count: 1, cb, stream, state };
        process.nextTick(afterWriteTick, state.afterWriteTickInfo);
      }
    } else {
      afterWrite(stream, state, 1, cb);
    }
  }
}

function afterWriteTick({ stream, state, count, cb }) {
  state.afterWriteTickInfo = null;
  return afterWrite(stream, state, count, cb);
}

function afterWrite(stream, state, count, cb) {
  const needDrain = !state.ending && !stream.destroyed && state.length === 0 &&
    state.needDrain;
  if (needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }

  while (count-- > 0) {
    state.pendingcb--;
    cb();
  }

  if (state.destroyed) {
    errorBuffer(state);
  }

  finishMaybe(stream, state);
}

// If there's something in the buffer waiting, then invoke callbacks.
function errorBuffer(state) {
  if (state.writing) {
    return;
  }

  for (let n = state.bufferedIndex; n < state.buffered.length; ++n) {
    const { chunk, callback } = state.buffered[n];
    const len = state.objectMode ? 1 : chunk.length;
    state.length -= len;
    callback(state.errored ?? new ERR_STREAM_DESTROYED('write'));
  }

  const onfinishCallbacks = state[kOnFinished].splice(0);
  for (let i = 0; i < onfinishCallbacks.length; i++) {
    onfinishCallbacks[i](state.errored ?? new ERR_STREAM_DESTROYED('end'));
  }

  resetBuffer(state);
}

// If there's something in the buffer waiting, then process it.
function clearBuffer(stream, state) {
  if (state.corked ||//塞住的时候不清空buffer
      state.bufferProcessing ||
      state.destroyed ||
      !state.constructed) {
    return;
  }

  const { buffered, bufferedIndex, objectMode } = state;
  const bufferedLength = buffered.length - bufferedIndex;

  if (!bufferedLength) {
    return;
  }

  let i = bufferedIndex;

  state.bufferProcessing = true;
  if (bufferedLength > 1 && stream._writev) {
    state.pendingcb -= bufferedLength - 1;

    const callback = state.allNoop ? nop : (err) => {
      for (let n = i; n < buffered.length; ++n) {
        buffered[n].callback(err);
      }
    };
    // Make a copy of `buffered` if it's going to be used by `callback` above,
    // since `doWrite` will mutate the array.
    const chunks = state.allNoop && i === 0 ?
      buffered : ArrayPrototypeSlice(buffered, i);
    chunks.allBuffers = state.allBuffers;
    // doWrite和onWrite结合，最终将buffer清空
    doWrite(stream, state, true, state.length, chunks, '', callback);

    resetBuffer(state);
  } else {
    do {// 感觉下面的代码有点问题，循环和回调做的事有重叠，不过下面的代码应该不会走了，等遇到_writev不存在的情况再说吧
      const { chunk, encoding, callback } = buffered[i];
      buffered[i++] = null;
      const len = objectMode ? 1 : chunk.length;
      doWrite(stream, state, false, len, chunk, encoding, callback);
    } while (i < buffered.length && !state.writing);

    if (i === buffered.length) {
      resetBuffer(state);
    } else if (i > 256) {
      buffered.splice(0, i);
      state.bufferedIndex = 0;
    } else {
      state.bufferedIndex = i;
    }
  }
  state.bufferProcessing = false;
}
// 可以看出_writev优先级较高，没有_writev就使用_write
// 这里均不可用，需要子类实现，例如：fs/streams.js里查看
// writev较之于write优势：https://stackoverflow.com/questions/10520182/linux-when-to-use-scatter-gather-io-readv-writev-vs-a-large-buffer-with-frea
Writable.prototype._write = function(chunk, encoding, cb) {
  if (this._writev) {
    this._writev([{ chunk, encoding }], cb);
  } else {
    throw new ERR_METHOD_NOT_IMPLEMENTED('_write()');
  }
};

Writable.prototype._writev = null;

Writable.prototype.end = function(chunk, encoding, cb) {
  const state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  let err;

  if (chunk !== null && chunk !== undefined) {
    const ret = _write(this, chunk, encoding);
    if (ret instanceof Error) {
      err = ret;
    }
  }

  // .end() fully uncorks.
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  if (err) {
    // Do nothing...
  } else if (!state.errored && !state.ending) {
    // This is forgiving in terms of unnecessary calls to end() and can hide
    // logic errors. However, usually such errors are harmless and causing a
    // hard error can be disproportionately destructive. It is not always
    // trivial for the user to determine whether end() needs to be called
    // or not.

    state.ending = true;
    finishMaybe(this, state, true);
    state.ended = true;
  } else if (state.finished) {
    err = new ERR_STREAM_ALREADY_FINISHED('end');
  } else if (state.destroyed) {
    err = new ERR_STREAM_DESTROYED('end');
  }

  if (typeof cb === 'function') {
    if (err || state.finished) {
      process.nextTick(cb, err);
    } else {
      state[kOnFinished].push(cb);
    }
  }

  return this;
};

function needFinish(state) {
  return (state.ending &&
          !state.destroyed &&
          state.constructed &&
          state.length === 0 &&
          !state.errored &&
          state.buffered.length === 0 &&
          !state.finished &&
          !state.writing &&
          !state.errorEmitted &&
          !state.closeEmitted);
}

function callFinal(stream, state) {
  let called = false;

  function onFinish(err) {
    if (called) {
      errorOrDestroy(stream, err ?? ERR_MULTIPLE_CALLBACK());
      return;
    }
    called = true;

    state.pendingcb--;
    if (err) {
      const onfinishCallbacks = state[kOnFinished].splice(0);
      for (let i = 0; i < onfinishCallbacks.length; i++) {
        onfinishCallbacks[i](err);
      }
      errorOrDestroy(stream, err, state.sync);
    } else if (needFinish(state)) {
      state.prefinished = true;
      stream.emit('prefinish');
      // Backwards compat. Don't check state.sync here.
      // Some streams assume 'finish' will be emitted
      // asynchronously relative to _final callback.
      state.pendingcb++;
      process.nextTick(finish, stream, state);
    }
  }

  state.sync = true;
  state.pendingcb++;

  try {
    const result = stream._final(onFinish);
    if (result != null) {
      const then = result.then;
      if (typeof then === 'function') {
        then.call(
          result,
          function() {
            if (!called) {
              process.nextTick(onFinish, null);
            }
          },
          function(err) {
            if (!called) {
              process.nextTick(onFinish, err);
            }
          });
      }
    }
  } catch (err) {
    onFinish(err);
  }

  state.sync = false;
}

function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === 'function' && !state.destroyed) {
      state.finalCalled = true;
      callFinal(stream, state);
    } else {
      state.prefinished = true;
      stream.emit('prefinish');
    }
  }
}

function finishMaybe(stream, state, sync) {
  if (needFinish(state)) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      if (sync) {
        state.pendingcb++;
        process.nextTick((stream, state) => {
          if (needFinish(state)) {
            finish(stream, state);
          } else {
            state.pendingcb--;
          }
        }, stream, state);
      } else if (needFinish(state)) {
        state.pendingcb++;
        finish(stream, state);
      }
    }
  }
}

function finish(stream, state) {
  state.pendingcb--;
  state.finished = true;

  const onfinishCallbacks = state[kOnFinished].splice(0);
  for (let i = 0; i < onfinishCallbacks.length; i++) {
    onfinishCallbacks[i]();
  }

  stream.emit('finish');

  if (state.autoDestroy) {
    // In case of duplex streams we need a way to detect
    // if the readable side is ready for autoDestroy as well.
    const rState = stream._readableState;
    const autoDestroy = !rState || (
      rState.autoDestroy &&
      // We don't expect the readable to ever 'end'
      // if readable is explicitly set to false.
      (rState.endEmitted || rState.readable === false)
    );
    if (autoDestroy) {
      stream.destroy();
    }
  }
}

ObjectDefineProperties(Writable.prototype, {

  closed: {
    get() {
      return this._writableState ? this._writableState.closed : false;
    }
  },

  destroyed: {
    get() {
      return this._writableState ? this._writableState.destroyed : false;
    },
    set(value) {
      // Backward compatibility, the user is explicitly managing destroyed.
      if (this._writableState) {
        this._writableState.destroyed = value;
      }
    }
  },

  writable: {
    get() {
      const w = this._writableState;
      // w.writable === false means that this is part of a Duplex stream
      // where the writable side was disabled upon construction.
      // Compat. The user might manually disable writable side through
      // deprecated setter.
      return !!w && w.writable !== false && !w.destroyed && !w.errored &&
        !w.ending && !w.ended;
    },
    set(val) {
      // Backwards compatible.
      if (this._writableState) {
        this._writableState.writable = !!val;
      }
    }
  },

  writableFinished: {
    get() {
      return this._writableState ? this._writableState.finished : false;
    }
  },

  writableObjectMode: {
    get() {
      return this._writableState ? this._writableState.objectMode : false;
    }
  },

  writableBuffer: {
    get() {
      return this._writableState && this._writableState.getBuffer();
    }
  },

  writableEnded: {
    get() {
      return this._writableState ? this._writableState.ending : false;
    }
  },

  writableNeedDrain: {
    get() {
      const wState = this._writableState;
      if (!wState) return false;
      return !wState.destroyed && !wState.ending && wState.needDrain;
    }
  },

  writableHighWaterMark: {
    get() {
      return this._writableState && this._writableState.highWaterMark;
    }
  },

  writableCorked: {
    get() {
      return this._writableState ? this._writableState.corked : 0;
    }
  },

  writableLength: {
    get() {
      return this._writableState && this._writableState.length;
    }
  },

  errored: {
    enumerable: false,
    get() {
      return this._writableState ? this._writableState.errored : null;
    }
  },

  writableAborted: {
    enumerable: false,
    get: function() {
      return !!(
        this._writableState.writable !== false &&
        (this._writableState.destroyed || this._writableState.errored) &&
        !this._writableState.finished
      );
    }
  },
});

const destroy = destroyImpl.destroy;
Writable.prototype.destroy = function(err, cb) {
  const state = this._writableState;

  // Invoke pending callbacks.
  if (!state.destroyed &&
    (state.bufferedIndex < state.buffered.length ||
      state[kOnFinished].length)) {
    process.nextTick(errorBuffer, state);
  }

  destroy.call(this, err, cb);
  return this;
};

Writable.prototype._undestroy = destroyImpl.undestroy;
Writable.prototype._destroy = function(err, cb) {
  cb(err);
};

Writable.prototype[EE.captureRejectionSymbol] = function(err) {
  this.destroy(err);
};

let webStreamsAdapters;

// Lazy to avoid circular references
function lazyWebStreams() {
  if (webStreamsAdapters === undefined)
    webStreamsAdapters = require('internal/webstreams/adapters');
  return webStreamsAdapters;
}

Writable.fromWeb = function(writableStream, options) {
  return lazyWebStreams().newStreamWritableFromWritableStream(
    writableStream,
    options);
};

Writable.toWeb = function(streamWritable) {
  return lazyWebStreams().newWritableStreamFromStreamWritable(streamWritable);
};
