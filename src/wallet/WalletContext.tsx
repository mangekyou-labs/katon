// Connected wallet = identity. No sign-in: the address persists in
// localStorage (as vanilla did) and the kit is re-pointed at the stored wallet
// on reload. connect() rethrows so the caller can toast the failure.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ADDRESS_KEY, FREIGHTER_ID, WALLET_ID_KEY, kit } from './kit';

interface WalletState {
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(() => localStorage.getItem(ADDRESS_KEY));

  // reload with a stored session: re-select the wallet module. Freighter is
  // the only module registered, so a remembered id from the multi-wallet era
  // (e.g. 'albedo') must not be replayed into the kit.
  useEffect(() => {
    if (localStorage.getItem(ADDRESS_KEY)) {
      kit.setWallet(FREIGHTER_ID);
    }
  }, []);

  const connect = useCallback(async () => {
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address: addr } = await kit.getAddress();
        localStorage.setItem(ADDRESS_KEY, addr);
        localStorage.setItem(WALLET_ID_KEY, option.id);
        setAddress(addr);
      },
    });
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(ADDRESS_KEY);
    localStorage.removeItem(WALLET_ID_KEY);
  }, []);

  return <Ctx.Provider value={{ address, connect, disconnect }}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useWallet outside WalletProvider');
  return ctx;
}
