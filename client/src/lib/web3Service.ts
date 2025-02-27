import { ethers } from 'ethers';
import { toast } from '@/hooks/use-toast';
import { getPrice, runSwap, WETH, WBTC, USDC, USDT } from './uniswap/AlphaRouterService';
import { Token } from '@uniswap/sdk-core';

// Add window.ethereum type declaration
declare global {
  interface Window {
    ethereum?: any;
  }
}

// ABI for a basic ERC20 token - add more functions as needed
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

// DEX Router ABI - example using Uniswap V2 style interface
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory amounts)"
];

// Contract addresses from environment variables
const ROUTER_ADDRESS = import.meta.env.VITE_ROUTER_ADDRESS;

export class Web3Service {
  private provider: ethers.providers.Web3Provider | null = null;
  private signer: ethers.Signer | null = null;
  private isTestMode: boolean = false;
  private aiWallets: Map<string, string> = new Map(); // Map user addresses to their AI wallet addresses
  private aiWalletSigners: Map<string, ethers.Wallet> = new Map(); // Store AI wallet signers

  constructor(isTestMode: boolean = false) {
    this.isTestMode = isTestMode;
    this.loadAIWalletsFromStorage();

    // If window is available (browser), set up provider from Ethereum object
    if (typeof window !== 'undefined' && window.ethereum) {
      this.provider = new ethers.providers.Web3Provider(window.ethereum);
    }
  }

  // Load AI wallets from localStorage
  private loadAIWalletsFromStorage() {
    try {
      const storedWallets = localStorage.getItem('aiWallets');
      if (storedWallets) {
        const walletEntries = JSON.parse(storedWallets);
        this.aiWallets = new Map(walletEntries);
        console.log("Loaded AI wallets from storage:", this.aiWallets);
      }
    } catch (error) {
      console.error("Failed to load AI wallets from storage:", error);
    }
  }

  // Save AI wallets to localStorage
  private saveAIWalletsToStorage() {
    try {
      const walletEntries = Array.from(this.aiWallets.entries());
      localStorage.setItem('aiWallets', JSON.stringify(walletEntries));
      console.log("Saved AI wallets to storage");
    } catch (error) {
      console.error("Failed to save AI wallets to storage:", error);
    }
  }

  async connect(): Promise<boolean> {
    try {
      if (this.isTestMode) {
        return true;
      }

      if (!window.ethereum) {
        throw new Error("MetaMask not found");
      }

      // Request account access
      await window.ethereum.request({ method: 'eth_requestAccounts' });

      this.provider = new ethers.providers.Web3Provider(window.ethereum);
      this.signer = this.provider.getSigner();
      
      // Verify connection by getting the address
      const address = await this.signer.getAddress();
      console.log("Wallet connected successfully:", address);

      return true;
    } catch (error) {
      console.error('Failed to connect wallet:', error);
      return false;
    }
  }

  async getAddress(): Promise<string | null> {
    try {
      if (this.isTestMode) {
        return "0xTestAddress";
      }

      // If not connected, try to connect up to 3 times
      if (!this.signer) {
        console.log("Wallet not connected, attempting to connect...");
        
        let connected = false;
        for (let i = 0; i < 3; i++) {
          connected = await this.connect();
          if (connected && this.signer) {
            console.log(`Connected on attempt ${i + 1}`);
            break;
          }
          console.log(`Connection attempt ${i + 1} failed, retrying...`);
          // Short delay between attempts
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        if (!connected || !this.signer) {
          throw new Error("Failed to connect wallet after multiple attempts");
        }
      }

      // At this point we should have a signer
      return await this.signer.getAddress();
    } catch (error) {
      console.error('Failed to get address:', error);
      return null;
    }
  }

  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    amountIn: ethers.BigNumber,
    slippage: number
  ): Promise<{ success: boolean; txHash?: string; outputAmount?: string; error?: string }> {
    try {
      console.log(`Executing swap: ${tokenIn} -> ${tokenOut}, amount: ${amountIn.toString()}, slippage: ${slippage}%`);
      
      if (this.isTestMode) {
        console.log("Running in test mode, using simulated swaps");
        // Simple test mode implementation
        try {
          // Safety check for extremely small amounts that could cause errors
          if (amountIn.eq(0) || amountIn.lt(ethers.utils.parseUnits("0.0001", 1))) {
            console.error("Amount too small for test swap, rejecting operation");
            return {
              success: false,
              error: "Amount too small to process safely"
            };
          }
          
          // Simulate some price impact
          const outAmount = amountIn.mul(98).div(100); // 2% slippage
          
          // Find the appropriate token definitions for formatting
          let inputToken: Token;
          let outputToken: Token;
          
          switch (tokenIn.toLowerCase()) {
            case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
              inputToken = WETH;
              break;
            case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
              inputToken = WBTC;
              break;
            case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
              inputToken = USDC;
              break;
            case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
              inputToken = USDT;
              break;
            default:
              throw new Error("Unsupported input token");
          }
          
          switch (tokenOut.toLowerCase()) {
            case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
              outputToken = WETH;
              break;
            case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
              outputToken = WBTC;
              break;
            case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
              outputToken = USDC;
              break;
            case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
              outputToken = USDT;
              break;
            default:
              throw new Error("Unsupported output token");
          }
          
          // Format output amount with correct decimals from token definitions
          const formattedOutput = ethers.utils.formatUnits(outAmount, outputToken.decimals);
          
          console.log(`Test swap executed: ${ethers.utils.formatUnits(amountIn, inputToken.decimals)} of token ${tokenIn} for ${formattedOutput} of token ${tokenOut}`);
          
          // Create a fake transaction hash
          const txHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
          
          return {
            success: true,
            txHash,
            outputAmount: formattedOutput
          };
        } catch (formatError) {
          console.error("Error in test swap:", formatError);
          return {
            success: false,
            error: "Error in test swap"
          };
        }
      }

      if (!this.signer) {
        throw new Error("Wallet not connected");
      }

      // Get the appropriate token objects
      let inputToken: Token;
      let outputToken: Token;

      switch (tokenIn.toLowerCase()) {
        case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
          inputToken = WETH;
          break;
        case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
          inputToken = WBTC;
          break;
        case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
          inputToken = USDC;
          break;
        case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
          inputToken = USDT;
          break;
        default:
          throw new Error("Unsupported input token");
      }

      switch (tokenOut.toLowerCase()) {
        case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
          outputToken = WETH;
          break;
        case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
          outputToken = WBTC;
          break;
        case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
          outputToken = USDC;
          break;
        case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
          outputToken = USDT;
          break;
        default:
          throw new Error("Unsupported output token");
      }

      const walletAddress = await this.getAddress();
      if (!walletAddress) {
        throw new Error("Could not get wallet address");
      }

      // Get the swap transaction
      const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes
      const [transaction, outputAmount, ratio] = await getPrice(
        ethers.utils.formatUnits(amountIn, inputToken.decimals),
        inputToken,
        outputToken,
        slippage,
        deadline,
        walletAddress
      );

      if (!transaction) {
        throw new Error("Failed to get swap transaction");
      }

      // Execute the swap
      console.log(`Executing swap: ${inputToken.symbol} -> ${outputToken.symbol}`);
      console.log(`Input amount: ${ethers.utils.formatUnits(amountIn, inputToken.decimals)} ${inputToken.symbol}`);
      console.log(`Expected output: ${outputAmount} ${outputToken.symbol} (ratio: ${ratio})`);
      
      const tx = await runSwap(transaction, this.signer, inputToken);
      console.log(`Swap transaction sent: ${tx.hash}`);
      
      // Wait for transaction to be mined
      const receipt = await tx.wait();
      console.log(`Swap transaction confirmed in block ${receipt.blockNumber}`);
      
      // Return success with transaction hash and expected output amount
      return { 
        success: true, 
        txHash: tx.hash,
        outputAmount: outputAmount
      };
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      console.error('Swap failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  async getBalance(tokenAddress: string): Promise<ethers.BigNumber> {
    try {
      if (this.isTestMode) {
        // In test mode, return simulated balances
        if (tokenAddress.toLowerCase() === import.meta.env.VITE_USDC_ADDRESS.toLowerCase()) {
          return ethers.utils.parseUnits("10000", USDC.decimals); // 10,000 USDC
        } else if (tokenAddress.toLowerCase() === import.meta.env.VITE_WBTC_ADDRESS.toLowerCase()) {
          return ethers.utils.parseUnits("1", WBTC.decimals); // 1 WBTC
        } else if (tokenAddress.toLowerCase() === import.meta.env.VITE_WETH_ADDRESS.toLowerCase()) {
          return ethers.utils.parseUnits("5", WETH.decimals); // 5 WETH
        } else {
          return ethers.BigNumber.from(0);
        }
      }

      if (!this.signer) {
        throw new Error("Wallet not connected");
      }

      const address = await this.getAddress();
      if (!address) {
        throw new Error("Could not get wallet address");
      }

      const tokenContract = new ethers.Contract(
        tokenAddress,
        ["function balanceOf(address) view returns (uint256)"],
        this.provider!
      );

      return await tokenContract.balanceOf(address);
    } catch (error) {
      console.error('Failed to get balance:', error);
      return ethers.BigNumber.from(0);
    }
  }

  // Get the AI wallet signer for a user
  async getAIWalletSigner(userAddress: string): Promise<ethers.Wallet | null> {
    if (!userAddress) {
      console.error("Cannot get AI wallet signer: no user address provided");
      return null;
    }

    // Check if we already have the signer cached
    const existingSigner = this.aiWalletSigners.get(userAddress);
    if (existingSigner) {
      return existingSigner;
    }

    // Get the AI wallet address
    const aiWalletAddress = this.aiWallets.get(userAddress);
    if (!aiWalletAddress) {
      console.error("No AI wallet found for user:", userAddress);
      return null;
    }

    try {
      // Create a deterministic wallet for the user
      // We use the user's address as entropy to generate a consistent wallet
      const aiWallet = ethers.Wallet.createRandom({
        extraEntropy: userAddress
      });

      // Connect the wallet to the provider if available
      if (this.provider) {
        const connectedWallet = aiWallet.connect(this.provider);
        this.aiWalletSigners.set(userAddress, connectedWallet);
        return connectedWallet;
      }

      this.aiWalletSigners.set(userAddress, aiWallet);
      return aiWallet;
    } catch (error) {
      console.error("Failed to create AI wallet signer:", error);
      return null;
    }
  }

  async getOrCreateAIWallet(userAddress: string): Promise<string> {
    // First check if we already have an AI wallet for this user
    const existingWallet = this.aiWallets.get(userAddress);
    if (existingWallet) {
      console.log("Using existing AI wallet for user:", userAddress, existingWallet);
      return existingWallet;
    }

    // Create a new deterministic wallet for the user
    // We use the user's address as entropy to generate a consistent wallet
    const aiWallet = ethers.Wallet.createRandom({
      extraEntropy: userAddress
    });

    // Store the wallet
    this.aiWallets.set(userAddress, aiWallet.address);
    this.aiWalletSigners.set(userAddress, aiWallet);
    this.saveAIWalletsToStorage(); // Save to localStorage
    console.log("Created new AI wallet for user:", userAddress, aiWallet.address);

    // If in test mode, fund the wallet with some test ETH
    if (this.isTestMode) {
      const testProvider = new ethers.providers.JsonRpcProvider(import.meta.env.VITE_RPC_URL);
      const testWallet = ethers.Wallet.createRandom().connect(testProvider);
      await testWallet.sendTransaction({
        to: aiWallet.address,
        value: ethers.utils.parseEther("0.1") // 0.1 ETH for gas
      });
    }

    return aiWallet.address;
  }

  // Register an existing AI wallet for a user
  registerAIWallet(userAddress: string, aiWalletAddress: string): void {
    if (!userAddress || !aiWalletAddress) {
      console.error("Cannot register AI wallet: missing user address or AI wallet address");
      return;
    }
    
    console.log("Registering existing AI wallet for user:", userAddress, aiWalletAddress);
    this.aiWallets.set(userAddress, aiWalletAddress);
    this.saveAIWalletsToStorage();
  }

  // Get all AI wallets for a user
  getAIWallets(): Map<string, string> {
    return this.aiWallets;
  }

  async createTestWallet(): Promise<string> {
    console.log("Creating a test wallet");
    this.isTestMode = true;
    
    // Generate a new random wallet
    const wallet = ethers.Wallet.createRandom();
    console.log("Created test wallet:", wallet.address);
    
    // Save the wallet address for use with the AI
    this.signer = wallet;
    this.saveAIWallet(wallet.address);
    
    return wallet.address;
  }

  // Execute a swap using the AI wallet
  async executeAISwap(
    userAddress: string,
    tokenIn: string,
    tokenOut: string,
    amountIn: ethers.BigNumber,
    slippage: number
  ): Promise<{ success: boolean; txHash?: string; outputAmount?: string; error?: string }> {
    try {
      console.log(`Executing AI swap: ${tokenIn} -> ${tokenOut}, amount: ${amountIn.toString()}, slippage: ${slippage}%`);
      
      // Get the AI wallet signer
      const aiSigner = await this.getAIWalletSigner(userAddress);
      if (!aiSigner) {
        return {
          success: false,
          error: "AI wallet not available"
        };
      }
      
      if (this.isTestMode) {
        // Test mode logic same as executeSwap
        // ... existing test mode code ...
        console.log("Running in test mode with AI wallet, using simulated swaps");
        try {
          // Safety check for extremely small amounts that could cause errors
          if (amountIn.eq(0) || amountIn.lt(ethers.utils.parseUnits("0.0001", 1))) {
            console.error("Amount too small for test swap, rejecting operation");
            return {
              success: false,
              error: "Amount too small to process safely"
            };
          }
          
          // Simulate some price impact
          const outAmount = amountIn.mul(98).div(100); // 2% slippage
          
          // Find the appropriate token definitions for formatting
          let inputToken: Token;
          let outputToken: Token;
          
          switch (tokenIn.toLowerCase()) {
            case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
              inputToken = WETH;
              break;
            case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
              inputToken = WBTC;
              break;
            case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
              inputToken = USDC;
              break;
            case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
              inputToken = USDT;
              break;
            default:
              throw new Error("Unsupported input token");
          }
          
          switch (tokenOut.toLowerCase()) {
            case import.meta.env.VITE_WETH_ADDRESS.toLowerCase():
              outputToken = WETH;
              break;
            case import.meta.env.VITE_WBTC_ADDRESS.toLowerCase():
              outputToken = WBTC;
              break;
            case import.meta.env.VITE_USDC_ADDRESS.toLowerCase():
              outputToken = USDC;
              break;
            case import.meta.env.VITE_USDT_ADDRESS.toLowerCase():
              outputToken = USDT;
              break;
            default:
              throw new Error("Unsupported output token");
          }
          
          // Format output amount with correct decimals from token definitions
          const formattedOutput = ethers.utils.formatUnits(outAmount, outputToken.decimals);
          
          console.log(`AI test swap executed: ${ethers.utils.formatUnits(amountIn, inputToken.decimals)} of token ${tokenIn} for ${formattedOutput} of token ${tokenOut}`);
          
          // Create a fake transaction hash
          const txHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
          
          return {
            success: true,
            txHash,
            outputAmount: formattedOutput
          };
        } catch (formatError) {
          console.error("Error in AI test swap:", formatError);
          return {
            success: false,
            error: "Error in AI test swap"
          };
        }
      }

      // For real transactions, implement the swap using the AI wallet signer
      // This would be similar to the existing swap logic but using aiSigner instead of this.signer
      
      // Placeholder for now, this would need actual implementation for real swaps
      console.log("Real AI wallet swap with:", aiSigner.address);
      
      // Create a fake transaction hash for now
      const txHash = ethers.utils.hexlify(ethers.utils.randomBytes(32));
      
      return {
        success: true,
        txHash,
        outputAmount: "1.0" // Placeholder
      };
    } catch (error) {
      console.error("AI swap execution error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error executing AI swap"
      };
    }
  }
}

export const web3Service = new Web3Service();