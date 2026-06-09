// The companion serial protocol is strict request/response, but
// meshcore.js matches responses to commands via global events — two
// in-flight commands can consume each other's responses and hang
// forever (observed on hardware with a busy mesh, spike 9). All radio
// commands therefore go through this FIFO queue: one in flight at a
// time, with a timeout so a lost response skips the command instead of
// wedging the queue.
const DEFAULT_TIMEOUT_MS = 15000;

class CommandQueue {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.tail = Promise.resolve();
  }

  run(fn, label) {
    const { timeoutMs } = this;
    const task = this.tail.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`radio command timed out${label ? `: ${label}` : ''}`));
      }, timeoutMs);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err || new Error(`radio command failed${label ? `: ${label}` : ''}`));
          },
        );
    }));
    // keep the chain alive on failure
    this.tail = task.catch(() => {});
    return task;
  }
}

module.exports = CommandQueue;
