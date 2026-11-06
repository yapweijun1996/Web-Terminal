// There is deliberately no injectable verifier or caller-selected principal.
// A future native adapter must authenticate the actual connected OS channel and
// independently establish a distinct protected service/supervisor principal.
export class TrustedVerifierUnavailable extends Error {
  constructor() { super("TRUSTED_VERIFIER_UNAVAILABLE"); this.code = "TRUSTED_VERIFIER_UNAVAILABLE"; }
}
export class MacOSTrustedTransport {
  async authorizeChannel(_channel) { throw new TrustedVerifierUnavailable(); }
}
