// Pinned Harmony update-channel signing keys, keyed by manifest key ID.
//
// These are PUBLIC keys (safe to commit). The resolver refuses any channel
// manifest that is not signed by one of these pins, so a compromised storage
// origin or CDN cannot forge a release through the install one-liners.
//
// Rotation: add the new key ID alongside the old one, deploy, publish
// releases signed with the new key, then remove the old pin in a later
// deploy. Changing a pin is a code change on purpose - it should be
// reviewed, not toggled.
//
// Provenance of the initial pin (see Harmony-AIO
// docs/dev/runbooks/dogfood-server-updates.md):
//   Key Vault: pa-az-har-updates-cf9d / harmony-update-signing
//   Key version: f0c52f6c65054f96ae5a340734877b2b
//   PEM SHA-256: 442ce2e3743ff74ddf7d51d3518857afd9486c0b20955e886e922ca467590e0f

export const PINNED_UPDATE_KEYS = {
  "dogfood-paus-2026-07-f0c52f6c": `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAsGG81O25i1vKcJxbeyNi
NDVw+hjISnD29gO7RSlRihl1njVrKOTt/giY3WJbZ8dqheVfM/8iobMzSAbzwB+p
LzN1Tj4UiW1gk0ofSOx1uP4qlgTluvrLiuxBgMqh4nXOPnOXWRFKLv6PoA4eGENZ
SNjXKvRM/M4a5Gg2guBTEFmeJSTEAwDR0Y/PJRionr5wVCbEKsLyBY7H3tpJT06M
vzfXFZo6d57mB+B0RgbgwR4DR4zSHlwgWYzZ20RBDmrxiIGdevapQWn5lxobNyxt
zzQsobie6Hn2lwDexME3GZJbHrLXfv6aVqokHYG9eMLJ4eycwUm7N9bOs8eb5SAR
S3wfqnLPk0Qg6mEz8ZUYgSqQDnjDIuljEykLeUmDsCmoFzqszqGLspaEfS2Ae/4u
ObepgoaZxPApXiz7TAC9IaH0k16kryhCrx2W1cFB49s9ddAxUg/y7owW9vhTfcYE
UsCutpzP0aBWOrffSYDT31Vaxmi1t9ZBiH0mZDdsy6QhAgMBAAE=
-----END PUBLIC KEY-----`,
};
