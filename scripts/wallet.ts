/**
 * Burner wallet tool.
 *   npm run wallet -- create     create an encrypted keystore (asks for a passphrase)
 *   npm run wallet -- address    print the public address
 *   npm run wallet -- verify     check the passphrase unlocks the keystore
 *   npm run wallet -- export --i-understand    print the secret key to import into Phantom/Solflare (recovery)
 *
 * Passphrases are read from the terminal with echo off, never from arguments or environment.
 */
import readline from "node:readline";
import { appConfig } from "../src/config";
import { createKeystore, exportSecretKey, keystoreAddress, keystoreExists, MIN_PASSPHRASE, unlockSigner } from "../src/wallet/keystore";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const w = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    w._writeToOutput = (s: string) => {
      if (s.includes(prompt)) w.output.write(s);
      else if (s.includes("\n") || s.includes("\r")) w.output.write("\n");
    };
    rl.question(prompt, (a) => {
      rl.close();
      resolve(a);
    });
  });
}

const file = appConfig.keystorePath;
const cmd = process.argv[2];

if (cmd === "create") {
  if (keystoreExists(file)) {
    console.error(`A keystore already exists at ${file}. Not overwriting it.`);
    process.exit(1);
  }
  const p1 = await ask(`Choose a passphrase (min ${MIN_PASSPHRASE} characters, there is no recovery if you lose it): `);
  const p2 = await ask("Repeat the passphrase: ");
  if (p1 !== p2) {
    console.error("Passphrases do not match.");
    process.exit(1);
  }
  const { address } = await createKeystore(file, p1);
  console.log(`\nCreated ${file}\nBurner address: ${address}\n`);
  console.log("Fund it with a small amount only. Back up the keystore file AND remember the passphrase.");
  console.log("To enable withdrawals, set OWNER_WALLET in .env to a wallet you control.");
} else if (cmd === "address") {
  const a = keystoreAddress(file);
  console.log(a ?? "No keystore yet. Run: npm run wallet -- create");
} else if (cmd === "verify") {
  const signer = await unlockSigner(file, await ask("Passphrase: ")).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  console.log(`OK. Unlocked ${signer.address}`);
} else if (cmd === "export") {
  if (!process.argv.includes("--i-understand")) {
    console.error("This prints your secret key. Anyone who sees it can take the funds. Re-run with --i-understand if you are alone.");
    process.exit(1);
  }
  console.log(await exportSecretKey(file, await ask("Passphrase: ")).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  }));
} else {
  console.log("Usage: npm run wallet -- create | address | verify | export --i-understand");
}
