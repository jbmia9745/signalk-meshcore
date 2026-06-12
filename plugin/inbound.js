// Inbound dispatch: replaces the Meshtastic packet subscriptions with the
// MeshCore queue model. Hardware-verified requirements (spec §10):
//  - drain the device queue immediately on connect (messages queue
//    on-device while no client is attached), then on every MsgWaiting push
//  - resolve DM senders via findContactByPublicKeyPrefix
//  - channel message text arrives as "SenderName: text"
const commands = require('./commands/index');

function parseChannelText(raw) {
  const sep = raw.indexOf(': ');
  if (sep === -1) {
    return { sender: null, text: raw };
  }
  return { sender: raw.slice(0, sep), text: raw.slice(sep + 2) };
}

// Replies launched immediately after an inbound exchange collide with
// that exchange's own RF wake (duplicate floods and ack echoes still
// relaying between repeaters) and die at marginal multi-hop links —
// field-verified: identical DMs failed at +50ms and delivered in 1.9s
// when sent cold. Delay command replies to let the air clear.
function delayedReplyDevice(device, settings) {
  const comms = settings.communications || {};
  const delayMs = 1000 * (comms.reply_delay_seconds === undefined ? 3 : comms.reply_delay_seconds);
  if (!delayMs) {
    return device;
  }
  return {
    ...device,
    sendText: (text, to) => new Promise((resolve, reject) => {
      setTimeout(() => device.sendText(text, to).then(resolve, reject), delayMs);
    }),
  };
}

function dispatch(msg, {
  settings, device, app, telemetry,
}) {
  const fromCrew = commands.isFromCrew(msg, settings);
  const replyDevice = delayedReplyDevice(device, settings);
  Object.keys(commands).forEach((cmd) => {
    if (cmd === 'isFromCrew') {
      return;
    }
    const command = commands[cmd];
    if (command.crewOnly && !fromCrew) {
      return;
    }
    if (!command.accept(msg, settings)) {
      return;
    }
    command.handle(msg, settings, replyDevice, app, telemetry)
      .then(() => {
        app.debug(`Message "${msg.data}" handled by command ${cmd}`);
      })
      .catch((err) => {
        app.debug(`Message "${msg.data}" failed in command ${cmd}: ${err.message}`);
        app.error(err.message);
      });
  });
}

function attachInbound(connection, Constants, deps) {
  const {
    app, queue, onContactMessage, onChannelMessage,
  } = deps;

  // Radio commands go through the queue one at a time; dispatch runs
  // outside it (handlers send replies, which enqueue their own commands —
  // holding the queue here would deadlock).
  async function drain() {
    const waiting = await queue.run(() => connection.getWaitingMessages(), 'getWaitingMessages');
    for (let i = 0; i < waiting.length; i += 1) {
      const m = waiting[i];
      if (m.contactMessage) {
        const cm = m.contactMessage;
        // eslint-disable-next-line no-await-in-loop
        const contact = await queue.run(
          () => connection.findContactByPublicKeyPrefix(cm.pubKeyPrefix),
          'findContact',
        );
        if (!contact) {
          app.debug('Inbound DM from unknown contact, ignoring');
        } else {
          const msg = {
            from: contact.publicKey,
            fromName: contact.advName,
            data: cm.text,
            senderTimestamp: cm.senderTimestamp,
          };
          app.debug(`Inbound DM from ${msg.fromName}: ${msg.data}`);
          if (onContactMessage) {
            onContactMessage(msg);
          }
          dispatch(msg, deps);
        }
      } else if (m.channelMessage && onChannelMessage) {
        const { sender, text } = parseChannelText(m.channelMessage.text);
        onChannelMessage({
          channelIdx: m.channelMessage.channelIdx,
          sender,
          text,
          senderTimestamp: m.channelMessage.senderTimestamp,
        });
      }
    }
  }

  connection.on(Constants.PushCodes.MsgWaiting, () => {
    drain().catch((e) => app.error(`Inbound drain failed: ${e.message}`));
  });

  // initial drain for messages queued while no client was attached
  return drain();
}

module.exports = { attachInbound, dispatch, parseChannelText };
