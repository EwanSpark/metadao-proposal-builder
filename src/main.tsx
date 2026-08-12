import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DEFAULT_NETWORK, ENV_RPC_URL, NETWORKS, type NetworkId } from "./config";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";

function Root() {
  const [network, setNetwork] = useState<NetworkId>(DEFAULT_NETWORK);
  const [customRpc, setCustomRpc] = useState(ENV_RPC_URL);

  const endpoint = useMemo(() => {
    if (network === "custom") return customRpc || NETWORKS.devnet.endpoint;
    return NETWORKS[network].endpoint;
  }, [network, customRpc]);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      {/* Empty array: modern wallet-adapter auto-detects Wallet Standard wallets. */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>
          <App
            network={network}
            setNetwork={setNetwork}
            customRpc={customRpc}
            setCustomRpc={setCustomRpc}
            endpoint={endpoint}
          />
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
