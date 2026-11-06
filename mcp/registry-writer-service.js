import { parseRequest } from "./registry-writer-protocol.js";
import { TrustedVerifierUnavailable } from "./registry-writer-transport.js";

// Not a listener, supervisor, writer, or deployment entry point. No caller or
// adapter can promote this candidate into a trusted service.
export class RegistryWriterCandidate {
  async handle(bytes) {
    parseRequest(bytes);
    throw new TrustedVerifierUnavailable();
  }
}
