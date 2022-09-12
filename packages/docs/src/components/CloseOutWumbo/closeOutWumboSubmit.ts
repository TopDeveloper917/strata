import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { SplTokenBonding } from "@strata-foundation/spl-token-bonding";
import {
  ITokenWithMetaAndAccount,
  SplTokenCollective,
} from "@strata-foundation/spl-token-collective";
import {
  sendAndConfirmWithRetry,
  sendInstructions,
  toNumber,
} from "@strata-foundation/spl-utils";
import React from "react";

interface ICloseOutWumboSubmitOpts {
  tokenBondingSdk: SplTokenBonding | undefined;
  tokens: ITokenWithMetaAndAccount[];
  expectedOutputAmountByToken: { [key: string]: number };
  setStatus: React.Dispatch<React.SetStateAction<string>>;
}

export const closeOutWumboSubmit = async ({
  tokenBondingSdk,
  tokens,
  expectedOutputAmountByToken,
  setStatus,
}: ICloseOutWumboSubmitOpts) => {
  let processedTokenCount = 0;
  let innerError: null | Error = null;

  if (!tokenBondingSdk) return;

  const openAta = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    SplTokenCollective.OPEN_COLLECTIVE_MINT_ID,
    tokenBondingSdk.wallet.publicKey
  );
  console.log(openAta.toBase58());
  if (!(await tokenBondingSdk.accountExists(openAta))) {
    setStatus("Setting up");
    const tx = new Transaction();
    tx.recentBlockhash = (
      await tokenBondingSdk.provider.connection.getLatestBlockhash()
    ).blockhash;
    tx.feePayer = tokenBondingSdk.wallet.publicKey;
    tx.add(
      Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        SplTokenCollective.OPEN_COLLECTIVE_MINT_ID,
        openAta,
        tokenBondingSdk.wallet.publicKey,
        tokenBondingSdk.wallet.publicKey
      )
    );
    const signed = await tokenBondingSdk.wallet.signTransaction(tx);

    await sendAndConfirmWithRetry(
      tokenBondingSdk.provider.connection,
      signed.serialize(),
      {
        skipPreflight: true,
      },
      "confirmed"
    );
  }

  setStatus("Recouping SOL");
  const txs = await Promise.all(
    tokens.map(async (token) => {
      const { publicKey: tokenBondingKey, targetMint } = token.tokenBonding;

      const { instructions: sellInstructions } =
        await tokenBondingSdk.sellInstructions({
          tokenBonding: tokenBondingKey,
          targetAmount: toNumber(token.account.amount, token.mint),
          expectedOutputAmount:
            expectedOutputAmountByToken[token.publicKey.toBase58()],
          slippage: 0.05,
        });
      const instructions = [
        ...sellInstructions,
        await Token.createCloseAccountInstruction(
          TOKEN_PROGRAM_ID,
          token.publicKey,
          tokenBondingSdk.wallet.publicKey,
          tokenBondingSdk.wallet.publicKey,
          []
        ),
      ];

      console.log(instructions);
      const tx = new Transaction();
      tx.recentBlockhash = (
        await tokenBondingSdk.provider.connection.getLatestBlockhash()
      ).blockhash;
      tx.feePayer = tokenBondingSdk.wallet.publicKey;
      tx.add(...instructions);

      return tx;
    })
  );

  const signed = await tokenBondingSdk.wallet.signAllTransactions(txs);

  for (let [index, tx] of signed.entries()) {
    setStatus(`Swapping: ${tokens[index].metadata?.data?.name}`);

    try {
      await sendAndConfirmWithRetry(
        tokenBondingSdk.provider.connection,
        tx.serialize(),
        {
          skipPreflight: true,
        },
        "confirmed"
      );

      processedTokenCount += 1;
    } catch (err) {
      // do nothing with error
      console.log(err);
    }
  }

  const openAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    SplTokenCollective.OPEN_COLLECTIVE_MINT_ID,
    tokenBondingSdk.wallet.publicKey
  );

  const openBalance =
    await tokenBondingSdk.provider.connection.getTokenAccountBalance(
      openAddress
    );

  setStatus("Swapping: $OPEN");
  const { instructions } = await tokenBondingSdk.sellInstructions({
    targetAmount: openBalance.value.uiAmount,
    tokenBonding: SplTokenCollective.OPEN_COLLECTIVE_BONDING_ID,
    slippage: 0.05,
  });
  const tx = new Transaction();
  tx.recentBlockhash = (
    await tokenBondingSdk.provider.connection.getLatestBlockhash()
  ).blockhash;
  tx.feePayer = tokenBondingSdk.wallet.publicKey;
  tx.add(...instructions);
  tx.add(
    await Token.createCloseAccountInstruction(
      TOKEN_PROGRAM_ID,
      openAta,
      tokenBondingSdk.wallet.publicKey,
      tokenBondingSdk.wallet.publicKey,
      []
    )
  );
  const signedTx = await tokenBondingSdk.wallet.signTransaction(tx);
  await sendAndConfirmWithRetry(
    tokenBondingSdk.provider.connection,
    signedTx.serialize(),
    {
      skipPreflight: true,
    },
    "confirmed"
  );

  if (processedTokenCount == tokens.length) {
    setStatus("successful");
  } else {
    setStatus("orphaned");
  }
};
