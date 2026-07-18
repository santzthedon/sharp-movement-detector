/**
 * One-time setup: generates a local Solana keypair and saves it to disk.
 *
 * Run: npm run setup:wallet
 *
 * After this, you still need to fund the wallet with devnet SOL before you
 * can subscribe on-chain. Do that with either:
 *   solana airdrop 2 <PUBKEY> --url devnet   (needs Solana CLI installed)
 * or a web faucet such as https://faucet.solana.com
 *
 * This SOL is only for Solana network fees - it has no cash value and is
 * not the TxL token. You do NOT need real money or a funded exchange
 * account for the free World Cup tier.
 */
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import { WALLET_PATH } from "./config";

function main() {
  if (fs.existsSync(WALLET_PATH)) {
    const existing = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8")))
    );
    console.log("Wallet already exists at", WALLET_PATH);
    console.log("Public key:", existing.publicKey.toBase58());
    return;
  }

  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_PATH, JSON.stringify(Array.from(kp.secretKey)));

  console.log("New wallet created:", WALLET_PATH);
  console.log("Public key:", kp.publicKey.toBase58());
  console.log("\nNext step - fund it with devnet SOL:");
  console.log(`  solana airdrop 2 ${kp.publicKey.toBase58()} --url devnet`);
  console.log("  (or paste the public key into https://faucet.solana.com)");
  console.log(
    "\nKeep wallet-devnet.json private - anyone with this file can sign as this wallet."
  );
}

main();
