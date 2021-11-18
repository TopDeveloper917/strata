import React from "react";
import { Provider } from "@project-serum/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { sendAndConfirmRawTransaction } from "@solana/web3.js";

/**
 * Get an anchor provider with signTransaction wrapped so that it hits the wallet adapter from wallet-adapter-react.
 *
 * @returns
 */
export function useProvider(): {
  provider: Provider | undefined;
  awaitingApproval: boolean;
} {
  const { connection } = useConnection();
  const { adapter } = useWallet();
  const [awaitingApproval, setAwaitingApproval] = React.useState(false);
  const provider = React.useMemo(() => {
    // Let adapter be null, it'll fail if anyone issues transaction commands but will let fetch go through
    // @ts-ignore
    const provider = new Provider(connection, adapter, {});

    // The default impl of send does not use the transaction resuling from wallet.signTransaciton. So we need to fix it.
    provider.send = async function FixedSend(tx, signers, opts) {
      if (signers === undefined) {
        signers = [];
      }
      if (opts === undefined) {
        opts = this.opts;
      }
      tx.feePayer = this.wallet.publicKey;
      tx.recentBlockhash = (
        await this.connection.getRecentBlockhash(opts.preflightCommitment)
      ).blockhash;
      setAwaitingApproval(true);
      try {
        const signed = await this.wallet.signTransaction(tx);
        signers
          .filter((s) => s !== undefined)
          .forEach((kp) => {
            signed.partialSign(kp!);
          });
        const rawTx = signed.serialize();
        const txId = await sendAndConfirmRawTransaction(
          connection,
          rawTx,
          opts
        );
        return txId;
      } finally {
        setAwaitingApproval(false);
      }
    };

    return provider;
  }, [connection, adapter]);

  return { provider, awaitingApproval };
}
