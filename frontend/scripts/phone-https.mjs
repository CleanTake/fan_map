// Start the development app on one private LAN address with a certificate for that IP.
import { createPrivateKey, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const addresses = Object.entries(networkInterfaces()).flatMap(([name, records]) =>
  (records ?? []).filter((r) => !r.internal && r.family === "IPv4" &&
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(r.address)).map((r) => ({ name, ip: r.address })));
const ip = process.argv[2] ?? addresses.find((a) => /wi-?fi|wireless/i.test(a.name))?.ip ??
  (addresses.length === 1 ? addresses[0].ip : undefined);
if (!addresses.some((a) => a.ip === ip)) {
  throw new Error("Choose the computer's private Wi-Fi/hotspot IP: node scripts/phone-https.mjs <IP>. Available: " +
    addresses.map((a) => a.name + " " + a.ip).join(", "));
}

const directory = join(tmpdir(), "FanMap-phone-https", ip);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const keyPath = join(directory, "server-key.pem"), certPath = join(directory, "server.pem");
const authorityPath = join(directory, "authority.pem"), publicPath = join(directory, "FanMap-phone-root.cer");

function existingCertificatesValid() {
  try {
    const leaf = new X509Certificate(readFileSync(certPath)), ca = new X509Certificate(readFileSync(publicPath));
    return ca.ca && leaf.checkIP(ip) && Date.parse(leaf.validTo) > Date.now() + 60_000 &&
      leaf.verify(ca.publicKey) && leaf.checkPrivateKey(createPrivateKey(readFileSync(keyPath))) &&
      new X509Certificate(readFileSync(authorityPath)).fingerprint256 === ca.fingerprint256;
  } catch { return false; }
}

if (!existingCertificatesValid()) {
  const gitOpenSSL = join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "usr", "bin", "openssl.exe");
  const binary = process.platform === "win32" && existsSync(gitOpenSSL) ? gitOpenSSL : "openssl";
  function openssl(args, input) {
    return execFileSync(binary, args, { input, windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
  }
  function keyPair() {
    return generateKeyPairSync("ec", { namedCurve: "prime256v1", privateKeyEncoding: { format: "pem", type: "pkcs8" },
      publicKeyEncoding: { format: "pem", type: "spki" } });
  }
  // OpenSSL requires a key file. Only an encrypted copy touches disk; its
  // random one-time passphrase goes through stdin and the file is discarded.
  const signer = keyPair(), server = keyPair();
  const pass = randomBytes(32).toString("hex");
  const signerPath = join(directory, "issuer-" + randomBytes(12).toString("hex") + ".pem");
  const encryptedSigner = createPrivateKey(signer.privateKey).export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: pass });
  const pubKeyPath = join(directory, "server-public.pem"), extPath = join(directory, "server-extensions.cnf");
  writeFileSync(pubKeyPath, server.publicKey);
  writeFileSync(extPath, ["basicConstraints=critical,CA:false", "keyUsage=critical,digitalSignature",
    "extendedKeyUsage=serverAuth", "subjectAltName=IP:" + ip].join("\n") + "\n");
  writeFileSync(signerPath, encryptedSigner, { mode: 0o600, flag: "wx" });
  try {
    const ca = openssl(["req", "-new", "-x509", "-key", signerPath, "-passin", "stdin", "-days", "30", "-sha256",
      "-subj", "/CN=FanMap phone test " + ip, "-addext", "basicConstraints=critical,CA:true,pathlen:0",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign"], pass + "\n");
    writeFileSync(authorityPath, ca);
    const leaf = openssl(["x509", "-new", "-force_pubkey", pubKeyPath, "-subj", "/CN=FanMap phone test server",
      "-CA", authorityPath, "-CAkey", signerPath, "-passin", "stdin", "-set_serial", "0x" + randomBytes(16).toString("hex"),
      "-extfile", extPath, "-days", "30", "-sha256"], pass + "\n");
    writeFileSync(keyPath, server.privateKey, { mode: 0o600 });
    writeFileSync(certPath, leaf);
    writeFileSync(publicPath, new X509Certificate(ca).raw);
  } finally { unlinkSync(signerPath); }
}

const endpoint = "https://" + ip + ":3443";
console.log("Phone URL:", endpoint);
console.log("Transfer only this public certificate to your phone:", publicPath);
console.log("Certificate SHA-256:", new X509Certificate(readFileSync(publicPath)).fingerprint256);
const next = join(root, "node_modules", "next", "dist", "bin", "next");
const origins = [process.env.FANMAP_DEV_ORIGINS, ip].filter(Boolean).join(",");
const child = spawn(process.execPath, [next, "dev", "--webpack", "--hostname", ip, "--port", "3443", "--experimental-https",
  "--experimental-https-key", keyPath, "--experimental-https-cert", certPath, "--experimental-https-ca", authorityPath],
  { cwd: root, stdio: "inherit", env: { ...process.env, FANMAP_DEV_ORIGINS: origins } });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
