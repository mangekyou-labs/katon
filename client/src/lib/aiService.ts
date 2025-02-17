import OpenAI from "openai";

let openai: OpenAI | null = null;

function initializeOpenAI() {
  const apiKey = window.process?.env?.VITE_OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("OpenAI API key not found. AI features will be disabled.");
    return null;
  }

  return new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true
  });
}

interface MarketAnalysis {
  recommendation: string;
  confidence: number;
  action: "BUY" | "SELL" | "HOLD";
  reasoning: string[];
}

export async function analyzeMarketConditions(
  currentPrice: number,
  priceHistory: number[],
  volume: number,
  rsi: number
): Promise<MarketAnalysis> {
  if (!openai) {
    openai = initializeOpenAI();
  }

  if (!openai) {
    return {
      recommendation: "AI analysis currently unavailable. Please check your API key configuration.",
      confidence: 0,
      action: "HOLD",
      reasoning: ["API key not configured", "System operating in fallback mode"]
    };
  }

  const prompt = `
Analyze these cryptocurrency market conditions and provide a trading recommendation:

Current Price: $${currentPrice}
24h Price History: ${priceHistory.join(", ")}
24h Trading Volume: $${volume}
RSI: ${rsi}

Provide analysis in JSON format:
{
  "recommendation": "Brief trading recommendation",
  "confidence": "Number between 0 and 1",
  "action": "BUY, SELL, or HOLD",
  "reasoning": ["Reason 1", "Reason 2", "Reason 3"]
}
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "You are a cryptocurrency trading expert AI. Provide specific, actionable analysis in the requested JSON format.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    const analysis = JSON.parse(content) as MarketAnalysis;
    return analysis;
  } catch (error) {
    console.error("Error analyzing market conditions:", error);
    return {
      recommendation: "Unable to perform market analysis at this time.",
      confidence: 0,
      action: "HOLD",
      reasoning: ["API error occurred", "Using conservative fallback strategy"],
    };
  }
}

export async function generateTradingStrategy(
  trades: { price: number; timestamp: Date; volume: number }[]
): Promise<string> {
  if (!openai) {
    openai = initializeOpenAI();
  }

  if (!openai) {
    return "AI trading strategy generation is currently unavailable. Please check your API key configuration.";
  }

  const prompt = `
Analyze this trading history and suggest a strategy:
${trades.map(t => `
Time: ${t.timestamp}
Price: $${t.price}
Volume: $${t.volume}
`).join("\n")}

Focus on:
1. Pattern recognition
2. Volume analysis
3. Price action
4. Risk management
`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4-turbo-preview",
      messages: [
        {
          role: "system",
          content: "You are a cryptocurrency trading expert AI. Provide detailed but concise strategy recommendations.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const content = response.choices[0].message.content;
    if (!content) {
      throw new Error("Empty response from OpenAI");
    }

    return content;
  } catch (error) {
    console.error("Error generating trading strategy:", error);
    return "Unable to generate trading strategy at this time. Please try again later.";
  }
}