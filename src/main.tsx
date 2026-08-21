import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { RPC_ENDPOINT } from "./config";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

function Root() {
  return (
    <ConnectionProvider
      endpoint={RPC_ENDPOINT}
      // web3.js defaults to 30s, which a slow endpoint routinely overruns on a
      // transaction that did land. flow.ts polls past a timeout anyway; this just
      // stops most of them from happening in the first place.
      config={{ commitment: "confirmed", confirmTransactionInitialTimeout: 120_000 }}
    >
      {/* Empty array: modern wallet-adapter auto-detects Wallet Standard wallets. */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
