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
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: "confirmed" }}>
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
