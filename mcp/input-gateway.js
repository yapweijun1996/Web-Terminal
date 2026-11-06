import brokerModule from '../runtime/gateway/broker.js';
import { TerminalController } from './terminal.js';

// Internal adapter only. Callers must authenticate and hold connection objects
// on the server; this module does not expose an identity or network API.
export function createInputGateway(options) {
  const controller = new TerminalController(options);
  const broker = new brokerModule.InputBroker({
    verifyTarget: target => controller.validate(target),
    execute: (target, operation) => {
      if (!operation || typeof operation !== 'object') throw Error('Invalid operation');
      if (operation.type === 'text') return controller.type(target, operation.text);
      if (operation.type === 'key') return controller.key(target, operation.key);
      throw Error('Unsupported operation');
    },
  });
  return { broker, controller };
}
