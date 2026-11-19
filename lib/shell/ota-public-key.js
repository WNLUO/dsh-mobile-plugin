/**
 * 桌面完整包 OTA 的内置签名公钥（Ed25519，SPKI PEM）。
 *
 * 私钥离线保管、不在这里；换发布方就换这一份，或用环境变量 DSH_OTA_PUBLIC_KEY_PEM 覆盖。
 * 公开公钥不涉及泄密，随包分发是正常的。
 */
export const OTA_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAKyPrnI61/wQkqWMfLAZCbPMdiYs7zQ5nhCg/RMltE/w=\n-----END PUBLIC KEY-----"
