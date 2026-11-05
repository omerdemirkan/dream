// Just enough of Node's crypto to check certificates and signatures the way a client would.
declare module "node:crypto" {
  export interface KeyObject {
    readonly asymmetricKeyDetails?: { readonly modulusLength?: number }
  }
  export class X509Certificate {
    constructor(pem: string)
    readonly subject: string
    readonly issuer: string
    readonly validFrom: string
    readonly validTo: string
    readonly keyUsage: Array<string>
    readonly publicKey: KeyObject
    readonly raw: { toString(encoding: "hex"): string }
    verify(publicKey: KeyObject): boolean
  }
  export function verify(algorithm: string, data: Uint8Array, key: KeyObject, signature: Uint8Array): boolean
  export function createHash(algorithm: string): {
    update(data: Uint8Array): { digest(encoding: "base64url"): string }
  }
}
