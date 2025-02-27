import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useQuery, useQueryClient, useMutation, InvalidateQueryFilters } from "@tanstack/react-query";
import { Strategy, Trade, Token } from "@shared/schema";
import { Switch } from "@/components/ui/switch";
import { Brain, AlertTriangle, Wallet } from "lucide-react";
import { apiRequest } from "@/lib/api";
import { analyzeMarketConditions, generateTradingStrategy, generateDexTradingDecision } from "@/lib/aiService";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { PerformanceChart } from "./PerformanceChart";
import { web3Service } from "@/lib/web3Service"; // Import web3Service
import { ethers } from "ethers";
import { TokenPairSelector } from "./TokenPairSelector";
import { useLocation } from "wouter";
import { useWallet } from '@/contexts/WalletContext';
import { ToastActionElement } from '@/components/ui/toast';
import { type ToastProps } from "@/components/ui/toast";
import type { ToasterToast } from "@/hooks/use-toast";
import { AIWalletSelector } from "./AIWalletSelector";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { strategyService, MemeStrategyConfig } from "@/lib/strategyService";
import { USDC, WBTC, WETH, USDT } from "@/lib/uniswap/AlphaRouterService"; // Import token definitions

// Use environment variables for token addresses
const USDC_ADDRESS = import.meta.env.VITE_USDC_ADDRESS;
const WBTC_ADDRESS = import.meta.env.VITE_WBTC_ADDRESS;
const WETH_ADDRESS = import.meta.env.VITE_WETH_ADDRESS;
const USDT_ADDRESS = import.meta.env.VITE_USDT_ADDRESS;

// Add these types at the top of the file
interface TradingSession {
  id: number;
  allocatedAmount: string;
  isActive: boolean;
}

interface TradingResponse {
  success: boolean;
  sessionId: number;
  message?: string;
}

// Add this component for the Memecoin Strategy Modal
function MemeStrategyModal({ 
  open, 
  onOpenChange, 
  onSave 
}: { 
  open: boolean; 
  onOpenChange: (open: boolean) => void; 
  onSave: (config: MemeStrategyConfig) => void;
}) {
  const [dipThreshold, setDipThreshold] = useState(30); // 30% dip
  const [timeWindow, setTimeWindow] = useState(5); // 5 minutes
  const [takeProfitMultiplier, setTakeProfitMultiplier] = useState(2);
  const [stopLossMultiplier, setStopLossMultiplier] = useState(0.5);
  const [partialTakeProfit, setPartialTakeProfit] = useState(true);
  const [partialTakeProfitPercentage, setPartialTakeProfitPercentage] = useState(50);
  const [isAIEnabled, setIsAIEnabled] = useState(true);
  const [investmentPercentage, setInvestmentPercentage] = useState(10); // 10% of allocated funds

  const handleSave = () => {
    onSave({
      dipThreshold,
      timeWindow,
      takeProfitMultiplier,
      stopLossMultiplier,
      partialTakeProfit,
      partialTakeProfitPercentage,
      isAIEnabled,
      investmentPercentage
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Configure Memecoin Bracket Orders</DialogTitle>
          <DialogDescription>
            Set up automated dip detection with take profit and stop loss orders for memecoins
          </DialogDescription>
        </DialogHeader>
        
        <Tabs defaultValue="basic" className="w-full mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="basic">Basic Settings</TabsTrigger>
            <TabsTrigger value="advanced">Advanced Settings</TabsTrigger>
          </TabsList>
          
          <TabsContent value="basic" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="investmentPercentage">Investment Percentage</Label>
              <div className="flex items-center space-x-2">
                <Slider
                  id="investmentPercentage"
                  min={1}
                  max={100}
                  step={1}
                  value={[investmentPercentage]}
                  onValueChange={values => setInvestmentPercentage(values[0])}
                />
                <span className="w-12 text-right">{investmentPercentage}%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Percentage of allocated funds to use for memecoin trading
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="dipThreshold">Buy Dip Threshold (%)</Label>
              <div className="flex items-center space-x-2">
                <Slider
                  id="dipThreshold"
                  min={5}
                  max={50}
                  step={1}
                  value={[dipThreshold]}
                  onValueChange={values => setDipThreshold(values[0])}
                />
                <span className="w-12 text-right">{dipThreshold}%</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Buy when price drops by this percentage within the time window
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="timeWindow">Time Window (minutes)</Label>
              <div className="flex items-center space-x-2">
                <Slider
                  id="timeWindow"
                  min={1}
                  max={60}
                  step={1}
                  value={[timeWindow]}
                  onValueChange={values => setTimeWindow(values[0])}
                />
                <span className="w-12 text-right">{timeWindow}m</span>
              </div>
            </div>
            
            <div className="flex items-center space-x-2">
              <Switch
                id="aiEnabled"
                checked={isAIEnabled}
                onCheckedChange={setIsAIEnabled}
              />
              <Label htmlFor="aiEnabled">AI Analysis</Label>
              <span className="text-xs text-muted-foreground ml-2">
                (Use AI to analyze memecoin chart before buying)
              </span>
            </div>
          </TabsContent>
          
          <TabsContent value="advanced" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="takeProfitMultiplier">Take Profit (multiplier)</Label>
              <div className="flex items-center space-x-2">
                <Slider
                  id="takeProfitMultiplier"
                  min={1.1}
                  max={10}
                  step={0.1}
                  value={[takeProfitMultiplier]}
                  onValueChange={values => setTakeProfitMultiplier(values[0])}
                />
                <span className="w-12 text-right">{takeProfitMultiplier}x</span>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="stopLossMultiplier">Stop Loss (multiplier)</Label>
              <div className="flex items-center space-x-2">
                <Slider
                  id="stopLossMultiplier"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={[stopLossMultiplier]}
                  onValueChange={values => setStopLossMultiplier(values[0])}
                />
                <span className="w-12 text-right">{stopLossMultiplier}x</span>
              </div>
            </div>
            
            <div className="flex items-center space-x-2">
              <Switch
                id="partialTakeProfit"
                checked={partialTakeProfit}
                onCheckedChange={setPartialTakeProfit}
              />
              <Label htmlFor="partialTakeProfit">Partial Take Profit</Label>
            </div>
            
            {partialTakeProfit && (
              <div className="space-y-2 pl-6">
                <Label htmlFor="partialTakeProfitPercentage">Percentage to Sell</Label>
                <div className="flex items-center space-x-2">
                  <Slider
                    id="partialTakeProfitPercentage"
                    min={10}
                    max={90}
                    step={5}
                    value={[partialTakeProfitPercentage]}
                    onValueChange={values => setPartialTakeProfitPercentage(values[0])}
                  />
                  <span className="w-12 text-right">{partialTakeProfitPercentage}%</span>
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
        
        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save Configuration</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Add this component for the Limit Order Strategy Modal
function LimitOrderStrategyModal({ 
  open, 
  onOpenChange, 
  onSave 
}: { 
  open: boolean; 
  onOpenChange: (open: boolean) => void; 
  onSave: (config: LimitOrderConfig) => void;
}) {
  const [buyThreshold, setBuyThreshold] = useState(5); // 5% below market
  const [sellThreshold, setSellThreshold] = useState(10); // 10% above market
  const [maxOrdersPerDay, setMaxOrdersPerDay] = useState(3);
  const [maxAllocationPerOrder, setMaxAllocationPerOrder] = useState(20); // 20% of funds per order
  const [useAIForPriceTargets, setUseAIForPriceTargets] = useState(true);

  const handleSave = () => {
    onSave({
      buyThreshold,
      sellThreshold,
      maxOrdersPerDay,
      maxAllocationPerOrder,
      useAIForPriceTargets
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Configure AI Limit Orders</DialogTitle>
          <DialogDescription>
            Set up AI-powered limit orders based on market analysis
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4 mt-4">
          <div className="space-y-2">
            <Label htmlFor="buyThreshold">Buy Threshold (%)</Label>
            <div className="flex items-center space-x-2">
              <Slider
                id="buyThreshold"
                min={1}
                max={20}
                step={0.5}
                value={[buyThreshold]}
                onValueChange={values => setBuyThreshold(values[0])}
              />
              <span className="w-12 text-right">{buyThreshold}%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Place buy orders this percentage below current market price
            </p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="sellThreshold">Sell Threshold (%)</Label>
            <div className="flex items-center space-x-2">
              <Slider
                id="sellThreshold"
                min={1}
                max={50}
                step={0.5}
                value={[sellThreshold]}
                onValueChange={values => setSellThreshold(values[0])}
              />
              <span className="w-12 text-right">{sellThreshold}%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Place sell orders this percentage above current market price
            </p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="maxOrdersPerDay">Max Orders Per Day</Label>
            <div className="flex items-center space-x-2">
              <Slider
                id="maxOrdersPerDay"
                min={1}
                max={10}
                step={1}
                value={[maxOrdersPerDay]}
                onValueChange={values => setMaxOrdersPerDay(values[0])}
              />
              <span className="w-12 text-right">{maxOrdersPerDay}</span>
            </div>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="maxAllocationPerOrder">Max Allocation Per Order (%)</Label>
            <div className="flex items-center space-x-2">
              <Slider
                id="maxAllocationPerOrder"
                min={5}
                max={100}
                step={5}
                value={[maxAllocationPerOrder]}
                onValueChange={values => setMaxAllocationPerOrder(values[0])}
              />
              <span className="w-12 text-right">{maxAllocationPerOrder}%</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Maximum percentage of allocated funds to use per order
            </p>
          </div>
          
          <div className="flex items-center space-x-2">
            <Switch
              id="useAIForPriceTargets"
              checked={useAIForPriceTargets}
              onCheckedChange={setUseAIForPriceTargets}
            />
            <Label htmlFor="useAIForPriceTargets">AI Price Targets</Label>
            <span className="text-xs text-muted-foreground ml-2">
              (Use AI to determine optimal price targets)
            </span>
          </div>
        </div>
        
        <DialogFooter className="mt-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>Save Configuration</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Add these types
interface MemeStrategyConfig {
  dipThreshold: number;
  timeWindow: number;
  takeProfitMultiplier: number;
  stopLossMultiplier: number;
  partialTakeProfit: boolean;
  partialTakeProfitPercentage: number;
  isAIEnabled: boolean;
  investmentPercentage: number;
}

interface LimitOrderConfig {
  buyThreshold: number;
  sellThreshold: number;
  maxOrdersPerDay: number;
  maxAllocationPerOrder: number;
  useAIForPriceTargets: boolean;
}

export function AIStrategyPanel() {
  const { toast } = useToast();
  const { isConnected, address, connect } = useWallet();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  
  const [analysis, setAnalysis] = useState<{
    recommendation: string;
    confidence: number;
    action: "BUY" | "SELL" | "HOLD";
    reasoning: string[];
  } | null>(null);
  
  const [isAutoTrading, setIsAutoTrading] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [allocatedFunds, setAllocatedFunds] = useState(0);
  const [logs, setLogs] = useState<{ message: string; type: 'info' | 'success' | 'error' }[]>([]);
  const [maxSlippage, setMaxSlippage] = useState(50); // 50%
  const [isError, setIsError] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<{
    action: "BUY" | "SELL" | "HOLD";
    tokenPair: string;
    amount: number;
    confidence: number;
    reasoning: string[];
    suggestedSlippage: number;
  } | null>(null);
  const [selectedAIWallet, setSelectedAIWallet] = useState<string | null>(null);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>('medium');
  const [isMemeStrategyEnabled, setIsMemeStrategyEnabled] = useState(false);
  const [isLimitOrderEnabled, setIsLimitOrderEnabled] = useState(false);
  const [showMemeStrategy, setShowMemeStrategy] = useState(false);
  const [showLimitOrderConfig, setShowLimitOrderConfig] = useState(false);
  const [memeStrategyConfig, setMemeStrategyConfig] = useState<MemeStrategyConfig>({
    dipThreshold: 30,
    timeWindow: 5,
    takeProfitMultiplier: 2,
    stopLossMultiplier: 0.5,
    partialTakeProfit: true,
    partialTakeProfitPercentage: 50,
    isAIEnabled: true,
    investmentPercentage: 10
  });
  const [limitOrderConfig, setLimitOrderConfig] = useState<LimitOrderConfig>({
    buyThreshold: 5,
    sellThreshold: 10,
    maxOrdersPerDay: 3,
    maxAllocationPerOrder: 20,
    useAIForPriceTargets: true
  });

  // Query for strategies
  const { data: strategies = [] } = useQuery({
    queryKey: ['strategies'],
    queryFn: async () => {
      try {
        const data = await apiRequest<Strategy[]>('/api/strategies');
        console.log("Fetched strategies:", data);
        return data || [];
      } catch (error) {
        console.error("Error fetching strategies:", error);
        return [];
      }
    }
  });

  // Reset strategy enablement when risk level changes
  useEffect(() => {
    // Debug log to see what's happening
    console.log("Risk level changed to:", riskLevel);
    
    // Create a safe reference to strategies
    const safeStrategies = strategies || [];
    console.log("Available strategies:", safeStrategies);
    
    // Disable strategies that don't match the current risk level
    if (riskLevel === 'low') {
      setIsMemeStrategyEnabled(false);
    } else if (riskLevel === 'medium') {
      setIsMemeStrategyEnabled(false);
    }
    
    // Reset backend strategies based on risk level
    // Only run this logic when strategies are available
    if (safeStrategies.length > 0) {
      let foundEnabledStrategy = false;
      
      safeStrategies.forEach(strategy => {
        const strategyRiskLevel = strategy.riskLevel || 'medium';
        console.log(`Strategy ${strategy.name} has risk level: ${strategyRiskLevel}`);
        
        // Determine if the strategy should be visible based on risk level
        const shouldBeVisible = 
          (riskLevel === 'low' && strategyRiskLevel === 'low') ||
          (riskLevel === 'medium' && strategyRiskLevel === 'medium') ||
          (riskLevel === 'high' && strategyRiskLevel === 'high');
        
        console.log(`Strategy ${strategy.name} should be visible: ${shouldBeVisible}`);
        
        // If strategy is not visible at current risk level, disable it
        if (!shouldBeVisible && strategy.enabled) {
          toggleStrategy(strategy.id, false);
        } else if (shouldBeVisible && strategy.enabled) {
          // If we already found an enabled strategy, disable this one
          if (foundEnabledStrategy) {
            toggleStrategy(strategy.id, false);
          } else {
            foundEnabledStrategy = true;
          }
        }
      });
    }
    
    // Log the risk level change
    addLog(`Risk level changed to ${riskLevel}`, 'info');
  }, [riskLevel, strategies]);

  const addLog = (message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setLogs(prev => [...prev, { message, type }]);
  };

  // Query for active trading session
  const { data: activeSession, error: sessionError, isLoading: isSessionLoading } = useQuery({
    queryKey: ['trading-session', address],
    queryFn: async () => {
      if (!address) return null;
      console.log('Fetching trading sessions for address:', address);
      try {
        const sessions = await apiRequest<TradingSession[]>('/api/trading/status', {
          params: { userAddress: address }
        });
        console.log('Received trading sessions:', sessions);
        return sessions?.[0] || null;
      } catch (error) {
        console.error('Error fetching trading sessions:', error);
        throw error;
      }
    },
    enabled: isConnected && !!address
  });

  // Log session information when it changes
  useEffect(() => {
    if (sessionError) {
      console.error('Session query error:', sessionError);
      addLog(`Error loading trading session: ${sessionError}`, 'error');
    } else if (activeSession) {
      console.log('Active session loaded:', activeSession);
      setSessionId(activeSession.id);
      setIsAutoTrading(activeSession.isActive);
      setAllocatedFunds(Number(activeSession.allocatedAmount));
      addLog(`Loaded existing trading session #${activeSession.id}`, 'info');
    } else if (!isSessionLoading && address) {
      console.log('No active trading session found for address:', address);
    }
  }, [activeSession, sessionError, isSessionLoading, address]);

  // Query for trades with auto-refresh
  const { data: trades } = useQuery({
    queryKey: ['trades'],
    queryFn: () => apiRequest<Trade[]>('/api/trades'),
    refetchInterval: 5000
  });

  // Query for tokens
  const { data: tokens } = useQuery({
    queryKey: ['tokens'],
    queryFn: () => apiRequest<Token[]>('/api/tokens')
  });

  const showToast = (description: string, variant: 'default' | 'destructive' = 'default') => {
    toast({
      description,
      variant
    });
  };

  const handleError = (error: unknown) => {
    setIsError(true);
    const errorMessage = error instanceof Error ? error.message : 'An error occurred';
    addLog(errorMessage, 'error');
    showToast(errorMessage, 'destructive');
  };

  const clearError = () => {
    setIsError(false);
  };

  const connectWallet = async (useTestWallet: boolean = false) => {
    try {
      clearError();
      let address: string | null = null;

      if (useTestWallet) {
        // Use web3Service's createTestWallet method
        address = await web3Service.createTestWallet();
        console.log("Connected to test wallet:", address);
        setAddress(address);
        setIsConnected(true);
        addLog(`Connected to test wallet: ${address.slice(0, 6)}...${address.slice(-4)}`, "success");
      } else {
        // Connect to real wallet
        const connected = await web3Service.connect();
        
        if (connected) {
          address = await web3Service.getAddress();
          console.log("Connected to wallet:", address);
          setAddress(address);
          setIsConnected(true);
          addLog(`Connected to wallet: ${address!.slice(0, 6)}...${address!.slice(-4)}`, "success");
        } else {
          throw new Error("Failed to connect wallet");
        }
      }

      // Fetch allocated funds from the server if already allocated
      if (address) {
        fetchTradingSessionData(address);
      }
    } catch (error) {
      handleError(error);
    }
  };

  // Add this function to handle wallet selection
  const handleAIWalletSelect = (walletAddress: string, allocatedAmount: number) => {
    setSelectedAIWallet(walletAddress);
    setAllocatedFunds(allocatedAmount);
    addLog(`Selected AI wallet: ${walletAddress.slice(0, 10)}...`, 'info');
  };

  const startTradingMutation = useMutation({
    mutationFn: async () => {
      // First ensure wallet is connected
      if (!isConnected) {
        await connectWallet(false);
      }
      
      const userAddress = await web3Service.getAddress();
      if (!userAddress) {
        console.error("Could not get wallet address");
        throw new Error("Could not get wallet address. Please make sure your wallet is connected.");
      }
      
      console.log("Starting trading session with user address:", userAddress);
      
      try {
        // Use selected AI wallet if available, otherwise create a new one
        const aiWalletAddress = selectedAIWallet || await web3Service.getOrCreateAIWallet(userAddress);
        console.log("Using AI wallet address:", aiWalletAddress);
        
        console.log("Making API request to start trading session with:", {
          userAddress, 
          aiWalletAddress, 
          allocatedAmount: allocatedFunds
        });
        
        return apiRequest<TradingResponse>('/api/trading/start', {
          method: 'POST',
          body: { 
            userAddress, 
            aiWalletAddress, 
            allocatedAmount: allocatedFunds 
          }
        });
      } catch (error) {
        console.error("Error in startTradingMutation:", error);
        throw error;
      }
    },
    onSuccess: (response) => {
      console.log("Trading session start response:", response);
      if (response.success) {
        setSessionId(response.sessionId);
        setIsAutoTrading(true);
        queryClient.invalidateQueries({ queryKey: ['trading'] });
        addLog('Auto-trading started successfully', 'success');
        showToast('Auto-trading started successfully');
      } else {
        console.error("Failed to start trading session:", response);
        throw new Error(response.message || "Failed to start trading session");
      }
    },
    onError: (error) => {
      console.error("Error starting trading session:", error);
      handleError(error);
    }
  });

  const stopTradingMutation = useMutation({
    mutationFn: async () => {
      if (!sessionId) {
        throw new Error("No active trading session found");
      }
      
      return apiRequest<TradingResponse>('/api/trading/stop', {
        method: 'POST',
        body: { sessionId }
      });
    },
    onSuccess: (response) => {
      if (response.success) {
        setSessionId(null);
        setIsAutoTrading(false);
        queryClient.invalidateQueries();
        addLog('Auto-trading stopped successfully', 'success');
        showToast('Auto-trading stopped successfully');
      } else {
        throw new Error(response.message || "Failed to stop trading session");
      }
    },
    onError: (error) => {
      handleError(error);
    }
  });

  const updateAllocationMutation = useMutation({
    mutationFn: async (amount: number) => {
      if (!sessionId) {
        throw new Error("No active trading session found");
      }
      
      return apiRequest<TradingResponse>(`/api/trading/session/${sessionId}`, {
        method: "PATCH",
        body: { allocatedAmount: amount }
      });
    },
    onSuccess: (response) => {
      if (response.success) {
        queryClient.invalidateQueries();
        addLog('Allocation updated successfully', 'success');
        showToast('Allocation updated successfully');
      } else {
        throw new Error(response.message || "Failed to update session allocation");
      }
    },
    onError: (error) => {
      handleError(error);
    }
  });

  const toggleAutoTrading = async (enabled: boolean) => {
    if (!isConnected) {
      showToast('Please connect your wallet first', 'destructive');
      return;
    }

    try {
      addLog(`${enabled ? 'Starting' : 'Stopping'} auto-trading...`, 'info');
      console.log(`${enabled ? 'Starting' : 'Stopping'} auto-trading with wallet address: ${address}`);
      
      if (enabled) {
        // Check if we have the necessary data
        if (!address) {
          throw new Error("Wallet address is not available");
        }
        
        // Log the request details
        console.log('Auto-trading start request:', {
          userAddress: address,
          aiWalletAddress: address, // Using same address for demo
          allocatedAmount: allocatedFunds
        });
        
        await startTradingMutation.mutateAsync();
      } else {
        if (!sessionId) {
          throw new Error("No active trading session found");
        }
        
        console.log('Auto-trading stop request for session:', sessionId);
        await stopTradingMutation.mutateAsync();
      }
    } catch (error) {
      console.error(`Error ${enabled ? 'starting' : 'stopping'} auto-trading:`, error);
      addLog(`Error ${enabled ? 'starting' : 'stopping'} auto-trading: ${error}`, 'error');
      showToast(`Failed to ${enabled ? 'start' : 'stop'} auto-trading: ${error}`, 'destructive');
    }
  };

  async function updateAnalysis() {
    try {
      if (!isAutoTrading) return;
      
      addLog("Analyzing market conditions...");
      
      // Default values if no trades/tokens exist
      const currentPrice = tokens?.find(t => t.symbol === "BTC")?.price || "50000.00";
      const priceHistory = trades?.map(t => Number(t.amountB)) || [Number(currentPrice)];
      const volume = trades?.reduce((sum, t) => sum + Number(t.amountA), 0) || 0;
      const rsi = calculateRSI(priceHistory);

      setIsError(false);
      const newAnalysis = await analyzeMarketConditions(
        Number(currentPrice),
        priceHistory,
        volume,
        rsi
      );

      if (newAnalysis.confidence === 0 && newAnalysis.reasoning[0].includes("API key")) {
        setIsError(true);
        addLog("AI Analysis failed: API key not configured", "error");
        toast({
          title: "AI Analysis Unavailable",
          description: "Please ensure your SONAR API key is properly configured.",
          variant: "destructive",
        });
      } else {
        setAnalysis(newAnalysis);
        addLog(`Analysis result: ${newAnalysis.action} with ${(newAnalysis.confidence * 100).toFixed(0)}% confidence`);

        if (isAutoTrading && allocatedFunds > 0) {
          addLog("Generating DEX trading decision...");
          // Use the new DEX-specific trading decision function
          const poolLiquidity = tokens?.find(t => t.symbol === "BTC")?.liquidity || "1000000";
          const dexDecision = await generateDexTradingDecision(
            "USDC",
            "WBTC",
            Number(currentPrice),
            priceHistory,
            Number(poolLiquidity),
            allocatedFunds
          );
          
          addLog(`DEX decision: ${dexDecision.action} ${dexDecision.amount.toFixed(2)} USDC with ${(dexDecision.confidence * 100).toFixed(0)}% confidence`);
          
          // Store the decision for potential manual execution
          setPendingDecision(dexDecision);
          
          // Execute trade based on the DEX-specific decision
          if (dexDecision.confidence > 0.7) {
            addLog("Confidence threshold met, executing trade...");
            await executeAutomatedDexTrade(dexDecision);
          } else {
            addLog("Confidence below threshold (70%), awaiting manual confirmation");
          }
        }
      }
    } catch (error: unknown) {
      setIsError(true);
      const errorMessage = error instanceof Error ? error.message : "Failed to update market analysis";
      addLog(`Error: ${errorMessage}`, "error");
      toast({
        title: "Analysis Error",
        description: errorMessage,
        variant: "destructive",
      });
    }
  }

  useEffect(() => {
    const interval = setInterval(updateAnalysis, 60000);
    if (isAutoTrading) {
      updateAnalysis();
    }

    return () => clearInterval(interval);
  }, [isAutoTrading]);

  async function executeAutomatedDexTrade(decision: {
    action: "BUY" | "SELL" | "HOLD";
    tokenPair: string;
    amount: number;
    confidence: number;
    reasoning: string[];
    suggestedSlippage: number;
  }) {
    if (decision.action === "HOLD") {
      console.log("Decision is HOLD, no trade to execute");
      return;
    }
    
    // Get the current user's address
    const userAddress = await web3Service.getAddress();
    if (!userAddress) {
      throw new Error("Wallet not connected");
    }
    
    if (decision.action === "BUY") {
      // Handle BUY transactions (USDC → WBTC)
      
      // Enforce minimum BUY amount to prevent decimal errors
      const minAmount = 5;
      if (decision.amount < minAmount) {
        const message = `Increasing buy amount to minimum threshold of ${minAmount} USDC`;
        console.log(message);
        addLog(message, "info");
        decision.amount = minAmount;
      }
      
      try {
        // Get token decimals from the imported token definitions
        const tokenDecimals = USDC.decimals; // This will be 18 for our testnet tokens
        const amountString = decision.amount.toFixed(tokenDecimals);
        console.log(`Parsing USDC amount: ${amountString} with ${tokenDecimals} decimals`);
        
        const amountIn = ethers.utils.parseUnits(amountString, tokenDecimals);
        console.log(`Parsed amount in wei: ${amountIn.toString()}`);
        
        // Use executeAISwap instead of executeSwap to use the AI wallet
        const result = await web3Service.executeAISwap(
          userAddress,
          USDC_ADDRESS,
          WBTC_ADDRESS,
          amountIn,
          decision.suggestedSlippage
        );

        if (result.success && result.txHash) {
          // Handle successful trade
          const outputAmount = result.outputAmount || "0";
          
          // Save the trade to the database
          await apiRequest<Trade>("/api/trades", {
            method: "POST",
            body: {
              tokenAId: 1, // USDC token ID
              tokenBId: 2, // WBTC token ID
              amountA: decision.amount.toString(),
              amountB: outputAmount,
              isAI: true
            }
          });

          toast({
            title: "AI Trade Executed",
            description: `Successfully bought WBTC with ${decision.amount} USDC. Received: ${outputAmount} WBTC`,
          });
          
          addLog(`Trade executed: ${decision.amount} USDC → ${outputAmount} WBTC`, "success");
          queryClient.invalidateQueries({ queryKey: ['trades'] });
        } else {
          throw new Error(result.error || "Trade failed");
        }
      } catch (parseError) {
        console.error("Error parsing or executing BUY trade:", parseError);
        addLog(`Error executing BUY trade: ${parseError instanceof Error ? parseError.message : String(parseError)}`, "error");
        throw parseError;
      }
    } else if (decision.action === "SELL") {
      // Handle SELL transactions
      
      // Enforce minimum SELL amount to prevent decimal errors
      const minAmount = 0.005;
      if (decision.amount < minAmount) {
        const message = `Increasing sell amount to minimum threshold of ${minAmount} WBTC`;
        console.log(message);
        addLog(message, "info");
        decision.amount = minAmount;
      }
      
      // Double-check for extremely small values that could cause errors
      if (decision.amount.toString().includes('e-') || decision.amount < 0.0001) {
        console.log("Detected extremely small amount in scientific notation, aborting trade");
        addLog("Trade amount too small, skipping execution", "error");
        throw new Error("Amount too small to execute trade safely");
      }
      
      console.log(`Executing SELL with amount: ${decision.amount} WBTC`);
      
      try {
        // Get token decimals from the imported token definitions
        const tokenDecimals = WBTC.decimals; // This will be 18 for our testnet tokens
        // Convert scientific notation to regular decimal string with appropriate decimal places
        let amountString;
        
        // Handle very small numbers that might be in scientific notation
        if (decision.amount.toString().includes('e')) {
          // We should never reach here due to our checks above, but just in case:
          console.log("Scientific notation detected, aborting trade");
          throw new Error("Cannot safely process amount in scientific notation");
        } else {
          amountString = decision.amount.toFixed(tokenDecimals);
        }
        
        console.log(`Parsing WBTC amount: ${amountString} with ${tokenDecimals} decimals`);
        
        // Double check that the amount string is valid for parseUnits
        if (!/^[0-9]+(\.[0-9]+)?$/.test(amountString)) {
          throw new Error(`Invalid amount format: ${amountString}`);
        }
        
        const amountIn = ethers.utils.parseUnits(amountString, tokenDecimals);
        console.log(`Parsed amount in wei: ${amountIn.toString()}`);
        
        // Use executeAISwap instead of executeSwap to use the AI wallet
        const result = await web3Service.executeAISwap(
          userAddress,
          WBTC_ADDRESS,
          USDC_ADDRESS,
          amountIn,
          decision.suggestedSlippage
        );

        if (result.success && result.txHash) {
          // Record the trade with the actual output amount
          const outputAmount = result.outputAmount || "0";
          
          // Save the trade to the database
          await apiRequest<Trade>("/api/trades", {
            method: "POST",
            body: {
              tokenAId: 2, // WBTC token ID
              tokenBId: 1, // USDC token ID
              amountA: decision.amount.toString(),
              amountB: outputAmount,
              isAI: true
            }
          });

          toast({
            title: "AI Trade Executed",
            description: `Successfully sold ${decision.amount} WBTC for ${outputAmount} USDC`,
          });
          
          addLog(`Trade executed: ${decision.amount} WBTC → ${outputAmount} USDC`, "success");
          queryClient.invalidateQueries({ queryKey: ['trades'] });
        } else {
          throw new Error(result.error || "Trade failed");
        }
      } catch (parseError) {
        console.error("Error parsing or executing SELL trade:", parseError);
        addLog(`Error executing SELL trade: ${parseError instanceof Error ? parseError.message : String(parseError)}`, "error");
        throw parseError;
      }
    }
  }

  const toggleStrategy = async (id: number, enabled: boolean) => {
    try {
      if (enabled) {
        // Disable all other strategies first
        const safeStrategies = strategies || [];
        safeStrategies.forEach(strategy => {
          if (strategy.id !== id && strategy.enabled) {
            toggleStrategy(strategy.id, false);
          }
        });
      }
      
      // Update the selected strategy status on the server
      await apiRequest<any>('/api/strategies/' + id, {
        method: 'PATCH',
        body: { enabled }
      });
      queryClient.invalidateQueries({ queryKey: ['strategies'] } as InvalidateQueryFilters);

      // Log the action
      addLog(`Strategy ${enabled ? 'enabled' : 'disabled'}`, enabled ? 'success' : 'info');
      
      toast({
        title: "Strategy Updated",
        description: `Strategy has been ${enabled ? 'enabled' : 'disabled'}`,
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Failed to update strategy status";
      toast({
        title: "Update Failed",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const renderTradingLogs = () => (
    <div className="mt-4 space-y-2">
      <h3 className="font-medium">Trading Activity Log</h3>
      <div className="h-40 overflow-y-auto rounded-md border border-border p-2 space-y-1">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trading activity yet</p>
        ) : (
          logs.map((log, i) => (
            <div key={i} className={`text-sm ${
              log.type === 'error' ? 'text-red-500' :
              log.type === 'success' ? 'text-green-500' :
              'text-muted-foreground'
            }`}>
              <span className="text-xs">{new Date().toLocaleTimeString()}</span>
              {' '}{log.message}
            </div>
          ))
        )}
      </div>
    </div>
  );

  // Add this function to manually execute a pending trade
  const executeManualTrade = async () => {
    if (!pendingDecision) {
      showToast("No pending trade decision available", "destructive");
      return;
    }
    
    try {
      addLog(`Manually executing ${pendingDecision.action} trade...`, "info");
      
      // Execute the trade
      await executeAutomatedDexTrade(pendingDecision);
      
      // Log the manual intervention to the server
      if (sessionId) {
        await apiRequest<{ success: boolean; message: string }>("/api/trading/manual-trade", {
          method: "POST",
          body: {
            sessionId,
            tradeDetails: {
              action: pendingDecision.action,
              tokenPair: pendingDecision.tokenPair,
              amount: pendingDecision.amount,
              suggestedSlippage: pendingDecision.suggestedSlippage,
              reasoning: pendingDecision.reasoning
            },
            confidence: pendingDecision.confidence
          }
        });
        
        // Refresh the trading session data
        queryClient.invalidateQueries(['trading-session', address]);
      }
      
      // Clear the pending decision after execution
      setPendingDecision(null);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to execute manual trade";
      addLog(`Error: ${errorMessage}`, "error");
      showToast(errorMessage, "destructive");
    }
  };

  // Add new useEffect to load memecoin config from server
  useEffect(() => {
    const loadMemeStrategyConfig = async () => {
      try {
        const config = await strategyService.getMemeStrategyConfig();
        setMemeStrategyConfig(config);
        
        // Check if the memecoin strategy is enabled
        const isEnabled = await strategyService.isMemeStrategyEnabled();
        setIsMemeStrategyEnabled(isEnabled);
      } catch (error) {
        console.error("Error loading memecoin strategy config:", error);
      }
    };
    
    loadMemeStrategyConfig();
  }, []);

  // Modify the memecoin strategy handler
  const handleMemeStrategyConfigSave = async (config: MemeStrategyConfig) => {
    try {
      await strategyService.saveMemeStrategyConfig(config);
      setMemeStrategyConfig(config);
      addLog(`Memecoin strategy configuration updated`, 'success');
      toast({
        title: "Configuration Saved",
        description: "Memecoin strategy configuration has been updated",
      });
    } catch (error) {
      console.error("Error saving memecoin strategy config:", error);
      addLog(`Error updating memecoin strategy configuration`, 'error');
      toast({
        title: "Configuration Error",
        description: "Failed to save memecoin strategy configuration",
        variant: "destructive"
      });
    }
  };

  // Add handler for limit order configuration
  const handleLimitOrderConfigSave = (config: LimitOrderConfig) => {
    try {
      setLimitOrderConfig(config);
      addLog(`Limit order strategy configuration updated`, 'success');
      toast({
        title: "Configuration Saved",
        description: "Limit order strategy configuration has been updated",
      });
    } catch (error) {
      console.error("Error saving limit order config:", error);
      addLog(`Error updating limit order configuration`, 'error');
      toast({
        title: "Configuration Error",
        description: "Failed to save limit order configuration",
        variant: "destructive"
      });
    }
  };

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center">
            <Brain className="mr-2 h-5 w-5" />
            AI Trading Strategy
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-6 text-destructive">
            <AlertTriangle className="mr-2 h-5 w-5" />
            <p>AI analysis unavailable. Please check API configuration.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center">
          <Brain className="mr-2 h-5 w-5" />
          AI Trading Strategy
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Step 1: Connect Wallet */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <Wallet className="mr-2 h-5 w-5" />
                <h3 className="font-semibold">Step 1: Connect Wallet</h3>
              </div>
              {!isConnected ? (
                <div className="space-x-2">
                  <Button size="sm" onClick={() => connectWallet(false)}>Connect Wallet</Button>
                  <Button size="sm" variant="outline" onClick={() => connectWallet(true)}>Use Test Wallet</Button>
                </div>
              ) : (
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">Connected</span>
                  <div className="h-2 w-2 rounded-full bg-green-500"></div>
                </div>
              )}
            </div>
          </div>

          {/* Step 2: Allocate Funds (Only shown when wallet is connected) */}
          {isConnected && (
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center">
                <div className="mr-2 h-5 w-5 flex items-center justify-center rounded-full bg-muted text-xs font-bold">2</div>
                <h3 className="font-semibold">Allocate Funds to AI Trading</h3>
              </div>
              
              <AIWalletSelector 
                userAddress={address} 
                onWalletSelect={handleAIWalletSelect} 
              />

              <div className="flex items-center justify-between">
                <span className="text-sm">Allocated Funds</span>
                <span className="font-semibold">${allocatedFunds.toLocaleString()}</span>
              </div>

              <div className="flex items-center space-x-2">
                <div className="relative flex-1">
                  <Input
                    type="number"
                    placeholder="Amount to allocate"
                    value={allocatedFunds === 0 ? "" : allocatedFunds}
                    onChange={(e) => {
                      // Allow decimal values
                      const value = parseFloat(e.target.value);
                      if (!isNaN(value)) {
                        setAllocatedFunds(value);
                      } else {
                        setAllocatedFunds(0);
                      }
                    }}
                    step="0.01"
                    min="0"
                    className="pr-16"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                    <span className="text-gray-500">USDC</span>
                  </div>
                </div>
                <Button size="sm" onClick={() => allocateFunds(allocatedFunds)}>Allocate</Button>
              </div>
              
              {/* DEX Integration Information */}
              <div className="rounded-md bg-muted p-3">
                <h4 className="mb-2 font-semibold">DEX Integration</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span>Router:</span>
                    <span className="font-mono text-xs">{import.meta.env.VITE_UNISWAP_ROUTER_ADDRESS.slice(0, 6)}...{import.meta.env.VITE_UNISWAP_ROUTER_ADDRESS.slice(-4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Factory:</span>
                    <span className="font-mono text-xs">{import.meta.env.VITE_UNISWAP_FACTORY_ADDRESS.slice(0, 6)}...{import.meta.env.VITE_UNISWAP_FACTORY_ADDRESS.slice(-4)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Chain ID:</span>
                    <span>{import.meta.env.VITE_CHAIN_ID}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Configure Strategies (Only shown when funds are allocated) */}
          {isConnected && allocatedFunds > 0 && (
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center">
                <div className="mr-2 h-5 w-5 flex items-center justify-center rounded-full bg-muted text-xs font-bold">3</div>
                <h3 className="font-semibold">Configure Trading Strategies</h3>
              </div>

              {/* Risk Level Selector */}
              <div className="space-y-2 p-4 border rounded-md bg-muted/30">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Risk Level</span>
                  <div className="flex items-center space-x-1">
                    <Button 
                      size="sm" 
                      variant={riskLevel === 'low' ? 'default' : 'outline'}
                      className={riskLevel === 'low' ? 'bg-green-600 hover:bg-green-700' : ''}
                      onClick={() => setRiskLevel('low')}
                    >
                      Low
                    </Button>
                    <Button 
                      size="sm" 
                      variant={riskLevel === 'medium' ? 'default' : 'outline'}
                      className={riskLevel === 'medium' ? 'bg-yellow-600 hover:bg-yellow-700' : ''}
                      onClick={() => setRiskLevel('medium')}
                    >
                      Medium
                    </Button>
                    <Button 
                      size="sm" 
                      variant={riskLevel === 'high' ? 'default' : 'outline'}
                      className={riskLevel === 'high' ? 'bg-red-600 hover:bg-red-700' : ''}
                      onClick={() => setRiskLevel('high')}
                    >
                      High
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {riskLevel === 'low' ? 'Conservative strategy with lower returns but reduced risk' : 
                   riskLevel === 'medium' ? 'Balanced approach with moderate risk and returns' : 
                   'Aggressive strategy with higher potential returns but increased risk'}
                </p>
                
                {riskLevel === 'high' && (
                  <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">
                    <AlertTriangle className="inline-block h-3 w-3 mr-1" />
                    Warning: High risk strategies may result in significant losses. Only use funds you can afford to lose.
                  </div>
                )}
              </div>

              {/* Strategy Selection */}
              <div className="space-y-4">
                <h4 className="font-medium">Available Strategies</h4>
                
                <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
                  <span className="font-medium">Note:</span> Only one strategy can be active at a time. Enabling a new strategy will automatically disable any currently active strategy.
                </div>
                
                {/* Display all strategies that match the current risk level */}
                {strategies?.filter(strategy => 
                  (riskLevel === 'low' && strategy.riskLevel === 'low') ||
                  (riskLevel === 'medium' && strategy.riskLevel === 'medium') ||
                  (riskLevel === 'high' && strategy.riskLevel === 'high')
                ).map((strategy) => (
                  <div
                    key={strategy.id}
                    className="flex items-center justify-between py-2 border-b border-border"
                  >
                    <div>
                      <p className="font-medium">{strategy.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {strategy.description || `${strategy.riskLevel || 'Medium'} risk trading strategy`}
                        {strategy.hasLimitOrders && " (includes limit orders)"}
                      </p>
                      <div className="flex items-center mt-1">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${
                          strategy.riskLevel === 'low' ? 'bg-green-100 text-green-800' :
                          strategy.riskLevel === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-red-100 text-red-800'
                        }`}>
                          {strategy.riskLevel || 'Medium'} Risk
                        </span>
                      </div>
                    </div>
                    <Switch
                      checked={strategy.enabled ?? false}
                      onCheckedChange={(checked) =>
                        toggleStrategy(strategy.id, checked)
                      }
                    />
                  </div>
                ))}

                {/* Memecoin Bracket Orders Strategy - Only show for High risk level */}
                {riskLevel === 'high' && (
                  <div className="flex items-center justify-between py-2 border-b border-border">
                    <div>
                      <p className="font-medium">Memecoin Bracket Orders</p>
                      <p className="text-sm text-muted-foreground">
                        Automated dip detection with take profit and stop loss
                      </p>
                      <div className="flex items-center mt-1">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-800">
                          High Risk
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Button 
                        size="sm" 
                        variant="outline"
                        onClick={() => setShowMemeStrategy(true)}
                      >
                        Configure
                      </Button>
                      <Switch
                        checked={isMemeStrategyEnabled}
                        onCheckedChange={async (checked) => {
                          if (checked) {
                            // Disable all other strategies first
                            const safeStrategies = strategies || [];
                            safeStrategies.forEach(strategy => {
                              if (strategy.enabled) {
                                toggleStrategy(strategy.id, false);
                              }
                            });
                          }
                          
                          try {
                            // Find the memecoin strategy
                            const memeStrategy = strategies?.find(s => s.name === "Memecoin Bracket Orders");
                            if (memeStrategy) {
                              await toggleStrategy(memeStrategy.id, checked);
                            }
                            setIsMemeStrategyEnabled(checked);
                          } catch (error) {
                            console.error("Error toggling memecoin strategy:", error);
                            toast({
                              title: "Strategy Error",
                              description: "Failed to toggle memecoin strategy",
                              variant: "destructive"
                            });
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Advanced Settings - Hidden by default, can be toggled */}
              <div className="mt-2">
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">
                    Advanced Settings
                  </summary>
                  <div className="mt-2 space-y-3 pl-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Max Slippage</span>
                        <span className="text-sm font-medium">{maxSlippage}%</span>
                      </div>
                      <Slider
                        min={0.1}
                        max={50}
                        step={0.1}
                        value={[maxSlippage]}
                        onValueChange={(values) => setMaxSlippage(values[0])}
                      />
                      <p className="text-xs text-muted-foreground">
                        Maximum allowed slippage for trades
                      </p>
                    </div>
                  </div>
                </details>
              </div>
            </div>
          )}

          {/* Step 4: Start Trading (Only shown when strategies are configured) */}
          {isConnected && allocatedFunds > 0 && (
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center">
                <div className="mr-2 h-5 w-5 flex items-center justify-center rounded-full bg-muted text-xs font-bold">4</div>
                <h3 className="font-semibold">Start AI Trading</h3>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <span className="text-sm">Auto-Trading</span>
                  {isAutoTrading && (
                    <div className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-800">Active</div>
                  )}
                </div>
                
                {/* Only enable button if a strategy is selected */}
                {(() => {
                  // Check if any strategy is enabled or if meme strategy is enabled
                  const hasEnabledStrategy = strategies.some(s => s.enabled) || isMemeStrategyEnabled;
                  
                  // Determine if button should be in "ready" state with glow effect
                  const isReadyToTrade = hasEnabledStrategy && !isAutoTrading;
                  
                  return (
                    <Button 
                      variant={isAutoTrading ? "outline" : "destructive"}
                      onClick={() => toggleAutoTrading(!isAutoTrading)}
                      className={`
                        ${isAutoTrading ? "bg-green-50 text-green-700 border-green-200" : ""}
                        ${isReadyToTrade ? "animate-pulse shadow-md shadow-red-400/40" : ""}
                      `}
                      disabled={!hasEnabledStrategy}
                    >
                      {isAutoTrading ? "Stop Trading" : "Start Trading"}
                      {!hasEnabledStrategy && !isAutoTrading && (
                        <span className="ml-2 text-xs">(Select a strategy first)</span>
                      )}
                    </Button>
                  );
                })()}
              </div>
            </div>
          )}

          {/* Trading Overview - Only shown when trading is active */}
          {isAutoTrading && (
            <div className="space-y-4 border-t pt-4">
              <h3 className="font-semibold">Trading Overview</h3>
              
              <div className="space-y-4">
                {/* Active Trading Pairs */}
                <div className="rounded-md bg-muted p-3">
                  <h5 className="text-sm font-medium mb-2">Active Trading Pairs</h5>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span>USDC/WBTC</span>
                      <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                        Primary Pair
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>USDC/WETH</span>
                      <span className="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded-full">
                        Secondary Pair
                      </span>
                    </div>
                  </div>
                </div>

                {/* Current Positions */}
                <div className="rounded-md bg-muted p-3">
                  <h5 className="text-sm font-medium mb-2">Current Positions</h5>
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <span>USDC Balance:</span>
                      <span className="font-medium">${allocatedFunds.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>WBTC Position:</span>
                      <span className="font-medium">0.0 WBTC</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span>WETH Position:</span>
                      <span className="font-medium">0.0 WETH</span>
                    </div>
                  </div>
                </div>

                {/* Trading Stats */}
                <div className="rounded-md bg-muted p-3">
                  <h5 className="text-sm font-medium mb-2">Trading Statistics</h5>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="text-center p-2 bg-background rounded">
                      <div className="text-sm text-muted-foreground">Win Rate</div>
                      <div className="font-medium">
                        {trades && trades.length > 0
                          ? `${calculateWinRate(trades)}%`
                          : "N/A"}
                      </div>
                    </div>
                    <div className="text-center p-2 bg-background rounded">
                      <div className="text-sm text-muted-foreground">Total Trades</div>
                      <div className="font-medium">
                        {trades?.length || 0}
                      </div>
                    </div>
                    <div className="text-center p-2 bg-background rounded">
                      <div className="text-sm text-muted-foreground">Avg. Profit</div>
                      <div className="font-medium">
                        {trades && trades.length > 0
                          ? `${calculateAvgProfit(trades)}%`
                          : "N/A"}
                      </div>
                    </div>
                    <div className="text-center p-2 bg-background rounded">
                      <div className="text-sm text-muted-foreground">Active Time</div>
                      <div className="font-medium">
                        {calculateActiveTime()}
                      </div>
                    </div>
                  </div>
                </div>
              </div>              
            </div>
          )}

          {/* Pending Decision - Only shown when there's a pending decision */}
          {isAutoTrading && pendingDecision && pendingDecision.action !== "HOLD" && (
            <div className="mt-4 p-3 border border-yellow-200 bg-yellow-50 rounded-md">
              <h4 className="font-medium text-yellow-800">Next AI Action</h4>
              <p className="text-sm text-yellow-700 mt-1">
                The AI will {pendingDecision.action === "BUY" ? "buy WBTC with" : "sell"} {pendingDecision.amount.toFixed(2)} {pendingDecision.action === "BUY" ? "USDC" : "WBTC"} 
                with {Math.round(pendingDecision.confidence * 100)}% confidence.
              </p>
              <div className="mt-2 space-y-1">
                {pendingDecision.reasoning.map((reason, i) => (
                  <div key={i} className="text-sm text-yellow-700">• {reason}</div>
                ))}
              </div>
            </div>
          )}

          {/* Trading Logs - Only shown when trading is active */}
          {isAutoTrading && renderTradingLogs()}

          {/* Move Past Trades and Performance Chart to the end */}
          
          {/* AI Market Analysis - Only shown when trading is active */}
          {isAutoTrading && analysis && (
            <div className="space-y-4 border-t pt-4">
              <h3 className="font-semibold">AI Market Analysis</h3>
              <div className="rounded-md bg-muted p-3">
                <p className="mb-2">{analysis.recommendation}</p>
                <div className="mb-2 flex items-center space-x-2">
                  <span className={`rounded-full px-2 py-1 text-xs ${
                    analysis.action === "BUY" ? "bg-green-100 text-green-800" :
                    analysis.action === "SELL" ? "bg-red-100 text-red-800" :
                    "bg-yellow-100 text-yellow-800"
                  }`}>
                    {analysis.action}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Confidence: {Math.round(analysis.confidence * 100)}%
                  </span>
                </div>
                <div className="space-y-1">
                  {analysis.reasoning.map((reason, i) => (
                    <div key={i} className="text-sm">• {reason}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Past Trades - Only shown when there are trades */}
          {trades && trades.length > 0 && (
            <div className="space-y-4 border-t pt-4">
              <h3 className="font-semibold">Past Trades</h3>
              <div className="rounded-md border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-2 text-left">Date</th>
                      <th className="px-4 py-2 text-left">Pair</th>
                      <th className="px-4 py-2 text-left">Type</th>
                      <th className="px-4 py-2 text-right">Amount</th>
                      <th className="px-4 py-2 text-right">Price</th>
                      <th className="px-4 py-2 text-right">P/L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.slice(0, 5).map((trade, i) => {
                      const isBuy = trade.tokenAId === 1; // Assuming tokenId 1 is USDC
                      const profitLoss = isBuy 
                        ? ((Number(trade.amountB) / Number(trade.amountA)) - 1) * 100
                        : ((Number(trade.amountA) / Number(trade.amountB)) - 1) * 100;
                      
                      return (
                        <tr key={i} className="border-t border-border">
                          <td className="px-4 py-2">{new Date(trade.createdAt || Date.now()).toLocaleDateString()}</td>
                          <td className="px-4 py-2">{isBuy ? 'USDC/WBTC' : 'WBTC/USDC'}</td>
                          <td className="px-4 py-2">{isBuy ? 'BUY' : 'SELL'}</td>
                          <td className="px-4 py-2 text-right">{Number(isBuy ? trade.amountA : trade.amountB).toFixed(2)}</td>
                          <td className="px-4 py-2 text-right">${Number(isBuy ? trade.amountB : trade.amountA).toFixed(2)}</td>
                          <td className={`px-4 py-2 text-right ${profitLoss >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {profitLoss.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {trades.length > 5 && (
                  <div className="px-4 py-2 text-center text-sm text-muted-foreground bg-muted/50">
                    + {trades.length - 5} more trades
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Performance Chart - Only shown when trading is active and there are trades */}
          {isAutoTrading && trades && trades.length > 0 && (
            <div className="space-y-4 border-t pt-4">
              <h3 className="font-semibold">Performance</h3>
              <PerformanceChart trades={trades} />
            </div>
          )}

          {/* Add the modals */}
          <MemeStrategyModal 
            open={showMemeStrategy} 
            onOpenChange={setShowMemeStrategy} 
            onSave={handleMemeStrategyConfigSave} 
          />
          
          <LimitOrderStrategyModal 
            open={showLimitOrderConfig} 
            onOpenChange={setShowLimitOrderConfig} 
            onSave={handleLimitOrderConfigSave} 
          />
        </div>
      </CardContent>
    </Card>
  );
}

function calculateRSI(prices: number[], periods = 14): number {
  if (prices.length < periods + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= periods; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  let avgGain = gains / periods;
  let avgLoss = losses / periods;

  for (let i = periods + 1; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      avgGain = (avgGain * (periods - 1) + difference) / periods;
      avgLoss = (avgLoss * (periods - 1)) / periods;
    } else {
      avgGain = (avgGain * (periods - 1)) / periods;
      avgLoss = (avgLoss * (periods - 1) - difference) / periods;
    }
  }

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateWinRate(trades: Trade[]): number {
  if (!trades.length) return 0;
  const profitableTrades = trades.filter(t => Number(t.amountB) > Number(t.amountA));
  return Math.round((profitableTrades.length / trades.length) * 100);
}

function calculateAvgProfit(trades: Trade[]): number {
  if (!trades.length) return 0;
  
  // Calculate profit percentage for each trade
  let totalProfit = 0;
  for (const trade of trades) {
    const profit = ((Number(trade.amountB) - Number(trade.amountA)) / Number(trade.amountA)) * 100;
    totalProfit += profit;
  }
  
  // Calculate average
  const avgProfit = totalProfit / trades.length;
  return Math.round(avgProfit * 100) / 100;
}

function calculateActiveTime(): string {
  // For now just return a placeholder
  return "2h 15m";
}