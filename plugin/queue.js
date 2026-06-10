// The companion serial protocol is strict request/response, but
// meshcore.js matches responses to commands via global events — two
// in-flight commands can consume each other's responses and hang
// forever (observed on hardware with a busy mesh, spike 9). All radio
// commands therefore go through this FIFO queue: one in flight at a
// time, with a timeout so a lost response skips the command instead of
// wedging the queue.
const DEFAULT_TIMEOUT_MS = 15000;

class CommandQueue {
  constructor(timeoutMs, { stallThreshold = 0, onStall } = {}) {
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.tail = Promise.resolve();
    // a timed-out command means no serial round-trip — N in a row means
    // the connection is stale (e.g. USB suspend) and only a reconnect
    // recovers it; any command that settles proves the link is alive
    this.stallThreshold = stallThreshold;
    this.onStall = onStall;
    this.consecutiveTimeouts = 0;
  }

  run(fn, label) {
    const { timeoutMs } = this;
    const task = this.tail.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.consecutiveTimeouts += 1;
        if (this.onStall && this.consecutiveTimeouts === this.stallThreshold) {
          this.onStall();
        }
        reject(new Error(`radio command timed out${label ? `: ${label}` : ''}`));
      }, timeoutMs);
      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            clearTimeout(timer);
            this.consecutiveTimeouts = 0;
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            this.consecutiveTimeouts = 0;
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
