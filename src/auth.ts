/**
 * Subscribes to the TxLINE free World Cup tier on-chain, then activates an
 * API token for use with the REST endpoints in oddsClient.ts.
 *
 * Run: npm run auth
 *
 * The Anchor IDL (./idl/txoracle.json) and generated TS types
 * (./types/txoracle.ts) are the devnet versions from TxODDS's official
 * examples repo: https://github.com/txodds/tx-on-chain
 * (examples/devnet/{idl,types}/). When switching NETWORK to mainnet,
 * replace them with the repo-root idl/txoracle.json and types/txoracle.ts,
 * which carry the mainnet program types.
 */
import * as anchor from "@coral-xyz/anchor";
import type { Txoracle } from "../types/txoracle";
import txoracleIdl from "../idl/txoracle.json";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import axios from "axios";
import nacl from "tweetnacl";
import * as fs from "fs";
import { NET, API_BASE, WALLET_PATH } from "./config";

async function main() {
  // --- Load wallet ---
  const secretKey = new Uint8Array(
    JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8"))
  );
  const payer = Keypair.fromSecretKey(secretKey);
  const wallet = new anchor.Wallet(payer);

  const connection = new Connection(NET.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const program = new anchor.Program<Txoracle>(
    txoracleIdl as Txoracle,
    provider
  );

  if (!program.programId.equals(NET.programId)) {
    throw new Error(
      `Loaded IDL program ${program.programId.toBase58()} does not match configured ${NET.programId.toBase58()}`
    );
  }

  // --- Subscribe on-chain to the free World Cup tier ---
  const SERVICE_LEVEL_ID = NET.freeServiceLevels.delayed60s; // start with the free delayed tier
  const DURATION_WEEKS = 4;
  const SELECTED_LEAGUES: number[] = []; // [] = standard free bundle

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    program.programId
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    NET.txlTokenMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    program.programId
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    NET.txlTokenMint,
    provider.wallet.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // A fresh wallet has no TXL Token-2022 account yet; the subscribe
  // instruction expects it to exist (the official devnet example creates it
  // the same way before subscribing).
  if (!(await connection.getAccountInfo(userTokenAccount))) {
    console.log("Creating TXL Token-2022 associated token account...");
    const createAtaTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userTokenAccount,
        payer.publicKey,
        NET.txlTokenMint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await sendAndConfirmTransaction(connection, createAtaTx, [payer], {
      commitment: "confirmed",
    });
  }

  console.log(`Subscribing on ${process.env.NETWORK || "devnet"}, service level ${SERVICE_LEVEL_ID}...`);

  const txSig = await program.methods
    .subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)
    .accounts({
      user: provider.wallet.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: NET.txlTokenMint,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Subscription tx confirmed:", txSig);

  // --- Activate API token ---
  const authResponse = await axios.post(NET.guestAuthUrl);
  const jwt = authResponse.data.token;

  const messageString = `${txSig}:${SELECTED_LEAGUES.join(",")}:${jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, payer.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const activationResponse = await axios.post(
    `${API_BASE}/token/activate`,
    { txSig, walletSignature, leagues: SELECTED_LEAGUES },
    { headers: { Authorization: `Bearer ${jwt}` } }
  );

  const apiToken = activationResponse.data.token || activationResponse.data;

  console.log("\nActivated. Add these to your .env:");
  console.log(`TXLINE_GUEST_JWT=${jwt}`);
  console.log(`TXLINE_API_TOKEN=${apiToken}`);
}

main().catch((err) => {
  console.error("Auth flow failed:", err?.response?.data || err);
  process.exit(1);
});
