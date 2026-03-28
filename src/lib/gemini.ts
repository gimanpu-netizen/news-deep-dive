import { GoogleGenAI, Modality, GenerateContentResponse } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

export async function generateNewsReport(topic: string, originalContent?: string, useSearch: boolean = true) {
  const model = "gemini-3-flash-preview";
  
  const safeTopic = topic.substring(0, 500);
  const safeContent = originalContent?.substring(0, 30000);

  const prompt = useSearch ? `
    トピック: ${safeTopic}
    ${safeContent ? `元の内容: ${safeContent}` : ""}

    上記トピックについて、最新のニュースや進展をGoogle検索でリサーチし、以下の形式で日本語のレポートを作成してください。
    
    1. 【最新の状況】: 現在何が起きているか、最新の事実を簡潔に。
    2. 【以前との違い】: もし元の内容がある場合、それから何が変わったか、どのような進展があったか。
    3. 【今後の展望】: 今後注目すべき点や予測される展開。
    
    レポートは、家事や通勤中に「耳で聴く」ことを想定し、自然な語り口で、かつ重要なポイントが伝わるように構成してください。
    著作権に配慮し、元の記事の丸写しではなく、あなたの言葉で再構成・要約してください。
  ` : `
    トピック: ${safeTopic}
    ${safeContent ? `元の内容: ${safeContent}` : ""}

    上記の内容を分析し、以下の形式で日本語のレポートを作成してください。
    ※Web検索による最新情報の調査は不要です。提供された内容のみに基づいてください。
    
    1. 【概要】: トピックや元の内容の要点を簡潔に。
    2. 【重要なポイント】: 特に注目すべき点やキーワード。
    3. 【考察】: この内容から読み取れることや、考えられる影響。
    
    レポートは、家事や通勤中に「耳で聴く」ことを想定し、自然な語り口で、かつ重要なポイントが伝わるように構成してください。
  `;

  try {
    const config: any = {};
    if (useSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    console.log("Gemini prompt:", prompt);
    try {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config,
        });
        console.log("Gemini response received:", response);

        if (!response.candidates || response.candidates.length === 0) {
          console.warn("Gemini returned no candidates. Response:", response);
          return { text: "レポートの生成に失敗しました（候補なし）。", groundingChunks: [] };
        }

        let text = "";
        try {
          text = response.text || "レポートの生成に失敗しました。";
        } catch (textErr) {
          console.warn("Error accessing response.text:", textErr);
          text = response.candidates[0].content?.parts?.[0]?.text || "レポートの生成に失敗しました（安全フィルターによりブロックされた可能性があります）。";
        }

        return {
          text: text.substring(0, 50000),
          groundingChunks: response.candidates[0].groundingMetadata?.groundingChunks || []
        };
      } catch (searchErr: any) {
        if (useSearch && (searchErr.message?.includes("tool") || searchErr.message?.includes("search"))) {
          console.warn("Search tool failed, retrying without search...", searchErr);
          const fallbackResponse = await ai.models.generateContent({
            model,
            contents: prompt,
            config: { ...config, tools: [] },
          });
          return {
            text: (fallbackResponse.text || "レポートの生成に失敗しました（検索なし）。").substring(0, 50000),
            groundingChunks: []
          };
        }
        throw searchErr;
      }
    } catch (err: any) {
      console.error("Gemini API Error:", err);
      if (err.message?.includes("quota")) throw new Error("quota exceeded");
      if (err.message?.includes("safety")) throw new Error("safety block");
      throw err;
    }
  } catch (error) {
    console.error("Gemini Report Error:", error);
    throw error;
  }
}

export async function generateAudio(text: string): Promise<string | undefined> {
  try {
    // Truncate text for TTS to prevent massive audio payloads.
    // 700 chars is roughly 2 minutes of speech, which at 24kHz 16-bit PCM 
    // results in ~6.7MB of raw data, or ~9MB when Base64 encoded.
    // This stays under the 11MB proxy limit.
    const safeText = text.substring(0, 700);
    
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `以下のレポートを、落ち着いた親しみやすい声で読み上げてください：\n\n${safeText}` }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio;
  } catch (error) {
    console.error("Gemini TTS Error:", error);
    return undefined;
  }
}
