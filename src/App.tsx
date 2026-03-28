import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Toaster, toast } from "sonner";
import { 
  auth, 
  db, 
  googleProvider, 
  signInWithPopup, 
  onAuthStateChanged, 
  User, 
  OperationType, 
  handleFirestoreError,
  serverTimestamp,
  Timestamp
} from "./lib/firebase";
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  addDoc, 
  deleteDoc, 
  doc, 
  updateDoc,
  getDoc,
  getDocs,
  setDoc
} from "firebase/firestore";
import { generateNewsReport, generateAudio } from "./lib/gemini";
import Markdown from "react-markdown";
import { format } from "date-fns";
import { ja } from "date-fns/locale";
import axios from "axios";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface Topic {
  id: string;
  title: string;
  description?: string;
  url?: string;
  originalContent?: string;
  userId: string;
  createdAt: Timestamp;
  lastUpdateAt: Timestamp;
}

interface Report {
  id: string;
  topicId: string;
  content: string;
  userId: string;
  createdAt: Timestamp;
  audioData?: string;
  groundingChunks?: any[];
}

type ViewState = 'home' | 'add' | 'detail' | 'player';

// --- Components ---

const ErrorBoundary: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [hasError, setHasError] = useState(false);
  const [errorInfo, setErrorInfo] = useState<any>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      try {
        const info = JSON.parse(event.error.message);
        if (info.error && info.operationType) {
          setHasError(true);
          setErrorInfo(info);
        }
      } catch (e) {
        // Not a Firestore error we handle
      }
    };
    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen bg-error-container flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-red-100">
          <div className="flex items-center gap-3 text-error mb-4">
            <span className="material-symbols-outlined text-3xl">error</span>
            <h1 className="text-xl font-bold">エラーが発生しました</h1>
          </div>
          <p className="text-on-surface-variant mb-6">
            申し訳ありません。データの処理中に問題が発生しました。
            {errorInfo?.error?.includes("insufficient permissions") && 
              "権限が不足しているようです。ログイン状態を確認してください。"}
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-error text-on-error py-3 rounded-xl font-bold hover:opacity-90 transition-colors"
          >
            再読み込み
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedTopic, setSelectedTopic] = useState<Topic | null>(null);
  const [activeReport, setActiveReport] = useState<Report | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAudioGenerating, setIsAudioGenerating] = useState(false);
  const [radioMode, setRadioMode] = useState(false);
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [currentView, setCurrentView] = useState<ViewState>('home');
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const formatTimestamp = (timestamp: any, formatStr: string) => {
    if (!timestamp || typeof timestamp.toDate !== 'function') return "";
    try {
      return format(timestamp.toDate(), formatStr, { locale: ja });
    } catch (e) {
      return "";
    }
  };

  // Auth
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const userDocRef = doc(db, "users", u.uid);
          const userDoc = await getDoc(userDocRef);
          if (!userDoc.exists()) {
            await setDoc(userDocRef, {
              email: u.email,
              displayName: u.displayName,
              createdAt: serverTimestamp(),
              role: "user"
            });
          }
        } catch (err) {
          console.error("User profile check failed:", err);
        }
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  // Data Fetching
  useEffect(() => {
    if (!user) return;

    const topicsQuery = query(
      collection(db, "topics"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsubscribeTopics = onSnapshot(topicsQuery, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Topic));
      docs.sort((a, b) => {
        const timeA = a.createdAt?.toMillis() || Date.now() + 10000;
        const timeB = b.createdAt?.toMillis() || Date.now() + 10000;
        return timeB - timeA;
      });
      setTopics(docs);
    }, (err) => handleFirestoreError(err, OperationType.LIST, "topics"));

    const reportsQuery = query(
      collection(db, "reports"),
      where("userId", "==", user.uid),
      orderBy("createdAt", "desc")
    );

    const unsubscribeReports = onSnapshot(reportsQuery, (snapshot) => {
      setReports(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Report)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, "reports"));

    return () => {
      unsubscribeTopics();
      unsubscribeReports();
    };
  }, [user]);

  // Audio Control
  const playAudio = async (base64Data: string) => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
    }

    try {
      const byteCharacters = atob(base64Data);
      const byteNumbers = new Uint8Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      
      // Detect if it already has a header
      const isWav = byteNumbers[0] === 0x52 && byteNumbers[1] === 0x49 && byteNumbers[2] === 0x46 && byteNumbers[3] === 0x46;
      const isMp3 = (byteNumbers[0] === 0x49 && byteNumbers[1] === 0x44 && byteNumbers[2] === 0x33) || 
                    (byteNumbers[0] === 0xFF && (byteNumbers[1] & 0xE0) === 0xE0);
      
      let finalBuffer: Uint8Array;
      let mimeType: string;

      if (isWav) {
        finalBuffer = byteNumbers;
        mimeType = 'audio/wav';
      } else if (isMp3) {
        finalBuffer = byteNumbers;
        mimeType = 'audio/mpeg';
      } else {
        // Assume raw PCM (16-bit, 24kHz, mono) and add WAV header
        // Gemini 2.5 Flash Preview TTS returns raw PCM
        const sampleRate = 24000;
        const numChannels = 1;
        const bitsPerSample = 16;
        
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        
        // RIFF identifier
        view.setUint32(0, 0x52494646, false); // "RIFF"
        // file length
        view.setUint32(4, 36 + byteNumbers.length, true);
        // RIFF type
        view.setUint32(8, 0x57415645, false); // "WAVE"
        // format chunk identifier
        view.setUint32(12, 0x666d7420, false); // "fmt "
        // format chunk length
        view.setUint32(16, 16, true);
        // sample format (raw)
        view.setUint16(20, 1, true);
        // channel count
        view.setUint16(22, numChannels, true);
        // sample rate
        view.setUint32(24, sampleRate, true);
        // byte rate (sample rate * block align)
        view.setUint32(28, sampleRate * numChannels * (bitsPerSample / 8), true);
        // block align (channel count * bytes per sample)
        view.setUint16(32, numChannels * (bitsPerSample / 8), true);
        // bits per sample
        view.setUint16(34, bitsPerSample, true);
        // data chunk identifier
        view.setUint32(36, 0x64617461, false); // "data"
        // data chunk length
        view.setUint32(40, byteNumbers.length, true);
        
        finalBuffer = new Uint8Array(header.byteLength + byteNumbers.length);
        finalBuffer.set(new Uint8Array(header), 0);
        finalBuffer.set(byteNumbers, header.byteLength);
        mimeType = 'audio/wav';
      }
      
      const blob = new Blob([finalBuffer], { type: mimeType });
      const url = URL.createObjectURL(blob);
      
      const audio = new Audio(url);
      audio.playbackRate = playbackSpeed;
      
      const cleanup = () => {
        URL.revokeObjectURL(url);
      };

      audio.onended = () => {
        setIsPlaying(false);
        cleanup();
        if (radioMode) playNextInRadio();
      };

      audio.onerror = (e) => {
        console.error("Audio element error:", e);
        cleanup();
        toast.error("音声の再生に失敗しました。形式がサポートされていない可能性があります。");
      };
      
      await audio.play();
      setCurrentAudio(audio);
      setIsPlaying(true);
    } catch (err) {
      console.error("Audio playback failed:", err);
      toast.error("再生の準備中にエラーが発生しました。");
    }
  };

  const togglePlay = () => {
    if (!currentAudio) return;
    if (isPlaying) {
      currentAudio.pause();
    } else {
      currentAudio.play();
    }
    setIsPlaying(!isPlaying);
  };

  const playNextInRadio = () => {
    const currentIndex = reports.findIndex(r => r.id === activeReport?.id);
    if (currentIndex < reports.length - 1) {
      handleSelectReport(reports[currentIndex + 1]);
    } else {
      setRadioMode(false);
    }
  };

  const handleSelectReport = async (report: Report) => {
    setActiveReport(report);
    setCurrentView('player');
    if (report.audioData) {
      playAudio(report.audioData);
    } else {
      setIsAudioGenerating(true);
      const audioPromise = generateAudio(report.content);
      
      toast.promise(audioPromise, {
        loading: '音声を生成中...',
        success: (audio) => {
          setIsAudioGenerating(false);
          if (audio) {
            // Save to Firestore if small enough
            if (audio.length < 1000000) {
              updateDoc(doc(db, "reports", report.id), { audioData: audio })
                .catch(err => console.error("Failed to save audio:", err));
            }
            playAudio(audio);
            return '音声の準備ができました';
          }
          return '音声の生成に失敗しました';
        },
        error: (err) => {
          setIsAudioGenerating(false);
          console.error("Audio generation error:", err);
          return '音声の生成中にエラーが発生しました';
        }
      });
    }
  };

  const handleRegisterTopic = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!user) return;
    const formData = new FormData(e.currentTarget);
    const urlInput = (formData.get("url") as string || "").trim().substring(0, 1000);
    const memoInput = (formData.get("memo") as string || "").trim().substring(0, 10000);
    
    const input = urlInput || memoInput;
    if (!input) return;

    setIsRegistering(true);
    try {
      let title = input;
      let url = urlInput || "";
      let originalContent = input;

      if (urlInput) {
        const scrapeRes = await axios.post("/api/scrape", { url: urlInput });
        title = scrapeRes.data.title || urlInput;
        originalContent = (scrapeRes.data.content + "\n\n" + memoInput).substring(0, 20000);
      } else {
        title = input.length > 30 ? input.substring(0, 30) + "..." : input;
      }

      const topicData = {
        title: title.substring(0, 200),
        url: url.substring(0, 1000),
        originalContent: originalContent.substring(0, 20000),
        userId: user.uid,
        createdAt: serverTimestamp(),
        lastUpdateAt: serverTimestamp(),
      };

      const docRef = await addDoc(collection(db, "topics"), topicData);
      
      const newTopic = { id: docRef.id, ...topicData } as Topic;
      setSelectedTopic(newTopic);
      setCurrentView('detail');
      
      setIsGenerating(true);
      const reportRes = await generateNewsReport(title, originalContent, false);
      const audio = await generateAudio(reportRes.text);

      if (audio) {
        toast.success("音声レポートの作成が完了しました！");
      } else {
        toast.error("音声の生成に失敗しました。テキストのみ保存します。");
      }

      const reportData = {
        topicId: docRef.id,
        content: reportRes.text,
        userId: user.uid,
        createdAt: serverTimestamp(),
        // Only store audio in Firestore if it's under the 1MB limit
        audioData: (audio && audio.length < 1000000) ? audio : "",
        groundingChunks: reportRes.groundingChunks || [],
      };

      const reportDocRef = await addDoc(collection(db, "reports"), reportData);
      const newReport = { id: reportDocRef.id, ...reportData } as Report;
      setActiveReport(newReport);
      
      // If audio was generated but too large to store, still play it now
      if (audio) playAudio(audio);

      setIsRegistering(false);
      setIsGenerating(false);
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      console.error(err);
      setIsRegistering(false);
      setIsGenerating(false);
    }
  };

  const handleRefreshTopic = async (topic: Topic) => {
    if (!user) return;
    console.log("Refreshing topic:", topic.title);
    setIsGenerating(true);
    try {
      console.log("Generating news report...");
      const reportRes = await generateNewsReport(topic.title, topic.originalContent, true);
      console.log("Report generated successfully");

      console.log("Generating audio...");
      const audio = await generateAudio(reportRes.text);
      console.log("Audio generation result:", audio ? "Success" : "Failed");

      if (audio) {
        toast.success("最新の音声レポートが完成しました！");
      } else {
        toast.error("音声の生成に失敗しました。");
      }

      const reportData = {
        topicId: topic.id,
        content: reportRes.text,
        userId: user.uid,
        createdAt: serverTimestamp(),
        // Only store audio in Firestore if it's under the 1MB limit
        audioData: (audio && audio.length < 1000000) ? audio : "",
        groundingChunks: reportRes.groundingChunks || [],
      };

      console.log("Adding report to Firestore...");
      const reportDocRef = await addDoc(collection(db, "reports"), reportData).catch(err => {
        handleFirestoreError(err, OperationType.CREATE, "reports");
        throw err;
      });
      
      const newReport = { id: reportDocRef.id, ...reportData } as Report;
      setActiveReport(newReport);

      console.log("Updating topic timestamp...");
      await updateDoc(doc(db, "topics", topic.id), {
        lastUpdateAt: serverTimestamp(),
      }).catch(err => {
        handleFirestoreError(err, OperationType.UPDATE, `topics/${topic.id}`);
        throw err;
      });

      // Update selected topic in state to reflect new timestamp
      setSelectedTopic({ ...topic, lastUpdateAt: Timestamp.now() });

      // If audio was generated but too large to store, still play it now
      if (audio) playAudio(audio);
    } catch (err: any) {
      console.error("Refresh Topic Error:", err);
      let errorMessage = "レポートの更新中にエラーが発生しました。";
      if (err instanceof Error) {
        if (err.message.includes("quota")) errorMessage = "APIの利用制限（クォータ）を超えました。しばらく待ってからお試しください。";
        else if (err.message.includes("permission")) errorMessage = "権限エラーが発生しました。ログイン状態を確認してください。";
        else if (err.message.includes("safety")) errorMessage = "安全フィルターにより内容がブロックされました。別のトピックをお試しください。";
      }
      toast.error(`${errorMessage} 詳細はコンソールを確認してください。`);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeleteTopic = async (id: string) => {
    try {
      // Delete associated reports first
      const q = query(collection(db, "reports"), where("topicId", "==", id));
      const snapshot = await getDocs(q);
      const deletePromises = snapshot.docs.map(doc => deleteDoc(doc.ref));
      await Promise.all(deletePromises);

      // Then delete the topic
      await deleteDoc(doc(db, "topics", id));

      if (selectedTopic?.id === id) {
        setSelectedTopic(null);
        setCurrentView('home');
      }
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteConfirmId(null);
      handleFirestoreError(err, OperationType.DELETE, `topics/${id}`);
    }
  };

  const renderDeleteConfirmation = () => {
    if (!deleteConfirmId) return null;
    const topic = topics.find(t => t.id === deleteConfirmId);
    if (!topic) return null;

    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-md z-[100] flex items-center justify-center p-6"
      >
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="bg-surface-container-lowest rounded-[2.5rem] p-8 max-w-sm w-full shadow-2xl border border-outline-variant/30"
        >
          <div className="w-16 h-16 bg-error-container text-on-error-container rounded-2xl flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-3xl">delete_forever</span>
          </div>
          <h3 className="text-2xl font-black text-on-surface mb-3 font-headline">トピックを削除</h3>
          <p className="text-on-surface-variant text-sm mb-8 leading-relaxed">
            「<span className="font-bold text-on-surface">{topic.title}</span>」と、これに関連するすべてのレポートを削除しますか？この操作は取り消せません。
          </p>
          <div className="flex flex-col gap-3">
            <button 
              onClick={() => handleDeleteTopic(deleteConfirmId)}
              className="w-full py-4 bg-error text-on-error font-bold rounded-2xl hover:opacity-90 active:scale-[0.98] transition-all"
            >
              削除する
            </button>
            <button 
              onClick={() => setDeleteConfirmId(null)}
              className="w-full py-4 bg-surface-container-highest text-on-surface-variant font-bold rounded-2xl hover:bg-surface-container-high active:scale-[0.98] transition-all"
            >
              キャンセル
            </button>
          </div>
        </motion.div>
      </motion.div>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md"
        >
          <div className="w-20 h-20 bg-primary-container rounded-3xl flex items-center justify-center mx-auto mb-8 shadow-lg">
            <span className="material-symbols-outlined text-on-primary text-4xl">menu_book</span>
          </div>
          <h1 className="text-4xl font-black text-on-surface mb-4 tracking-tight font-headline">
            The Editorial Insight
          </h1>
          <p className="text-on-surface-variant mb-12 text-lg leading-relaxed">
            気になるニュースの「その後」をAIが自動でリサーチ。<br/>
            家事や通勤中に、最新情報を耳でキャッチ。
          </p>
          <button 
            onClick={() => signInWithPopup(auth, googleProvider)}
            className="w-full bg-primary text-on-primary py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 hover:opacity-90 transition-all active:scale-95 shadow-xl"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-6 h-6 bg-white rounded-full p-0.5" alt="Google" />
            Googleで始める
          </button>
        </motion.div>
      </div>
    );
  }

  const renderTopAppBar = () => (
    <header className="bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl docked full-width top-0 sticky z-50 no-line tonal-layering bg-slate-50 dark:bg-slate-950">
      <div className="flex justify-between items-center w-full px-6 py-4 max-w-7xl mx-auto">
        <div className="flex items-center gap-3">
          {currentView !== 'home' ? (
            <button 
              onClick={() => setCurrentView('home')}
              className="hover:bg-slate-100/50 dark:hover:bg-slate-800/50 transition-colors p-2 rounded-full scale-95 active:opacity-80 transition-all"
            >
              <span className="material-symbols-outlined text-indigo-900 dark:text-indigo-100">arrow_back</span>
            </button>
          ) : (
            <span className="material-symbols-outlined text-indigo-900 dark:text-indigo-100">menu_book</span>
          )}
          <h1 className="text-indigo-950 dark:text-white font-extrabold tracking-tighter font-headline text-lg">
            {currentView === 'player' ? 'レポート再生' : 'The Editorial Insight'}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-6 mr-4">
            <button onClick={() => setCurrentView('home')} className={cn("transition-colors px-3 py-1 rounded-lg text-sm font-medium", currentView === 'home' ? "text-indigo-700 font-bold" : "text-slate-500 hover:bg-slate-100/50")}>Dictionary</button>
            <button onClick={() => setCurrentView('add')} className={cn("transition-colors px-3 py-1 rounded-lg text-sm font-medium", currentView === 'add' ? "text-indigo-700 font-bold" : "text-slate-500 hover:bg-slate-100/50")}>Add New</button>
            <button onClick={() => { if(activeReport) setCurrentView('player'); }} className={cn("transition-colors px-3 py-1 rounded-lg text-sm font-medium", currentView === 'player' ? "text-indigo-700 font-bold" : "text-slate-500 hover:bg-slate-100/50")}>Player</button>
          </div>
          <div className="w-10 h-10 rounded-full bg-secondary-container flex items-center justify-center overflow-hidden border-2 border-white shadow-sm cursor-pointer" onClick={() => auth.signOut()}>
            {user.photoURL ? (
              <img src={user.photoURL} alt="User" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            ) : (
              <span className="material-symbols-outlined text-on-secondary-container">person</span>
            )}
          </div>
        </div>
      </div>
    </header>
  );

  const renderBottomNavBar = () => (
    <nav className="md:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-white/85 dark:bg-slate-900/85 backdrop-blur-2xl shadow-[0px_-12px_32px_rgba(25,28,30,0.06)] rounded-t-[1.5rem]">
      <button 
        onClick={() => setCurrentView('home')}
        className={cn(
          "flex flex-col items-center justify-center px-6 py-2 transition-transform active:scale-90 duration-200 rounded-2xl",
          currentView === 'home' ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-100" : "text-slate-400 dark:text-slate-500 hover:text-indigo-600"
        )}
      >
        <span className="material-symbols-outlined mb-1" style={{ fontVariationSettings: currentView === 'home' ? "'FILL' 1" : "'FILL' 0" }}>subscriptions</span>
        <span className="font-inter text-[11px] font-semibold uppercase tracking-wider">Dictionary</span>
      </button>
      <button 
        onClick={() => setCurrentView('add')}
        className={cn(
          "flex flex-col items-center justify-center px-6 py-2 transition-transform active:scale-90 duration-200 rounded-2xl",
          currentView === 'add' ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-100" : "text-slate-400 dark:text-slate-500 hover:text-indigo-600"
        )}
      >
        <span className="material-symbols-outlined mb-1" style={{ fontVariationSettings: currentView === 'add' ? "'FILL' 1" : "'FILL' 0" }}>add_circle</span>
        <span className="font-inter text-[11px] font-semibold uppercase tracking-wider">Add New</span>
      </button>
      <button 
        onClick={() => { if(activeReport) setCurrentView('player'); }}
        className={cn(
          "flex flex-col items-center justify-center px-6 py-2 transition-transform active:scale-90 duration-200 rounded-2xl",
          currentView === 'player' ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-100" : "text-slate-400 dark:text-slate-500 hover:text-indigo-600"
        )}
      >
        <span className="material-symbols-outlined mb-1" style={{ fontVariationSettings: currentView === 'player' ? "'FILL' 1" : "'FILL' 0" }}>graphic_eq</span>
        <span className="font-inter text-[11px] font-semibold uppercase tracking-wider">Player</span>
      </button>
    </nav>
  );

  const renderMiniPlayer = () => {
    if (!activeReport || currentView === 'player') return null;
    const topic = topics.find(t => t.id === activeReport.topicId);
    return (
      <div className="fixed bottom-24 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-4xl z-[60] cursor-pointer" onClick={() => setCurrentView('player')}>
        <div className="bg-white/85 dark:bg-slate-900/85 backdrop-blur-2xl rounded-2xl p-4 shadow-[0px_12px_32px_rgba(25,28,30,0.12)] border border-white/20 flex items-center gap-4">
          <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center text-white shrink-0">
            <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>graphic_eq</span>
          </div>
          <div className="flex-grow min-w-0">
            <p className="text-[11px] font-bold text-primary uppercase tracking-widest mb-0.5">Now Briefing</p>
            <h4 className="text-sm font-bold truncate">{topic?.title || "レポート再生中"}</h4>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={(e) => { e.stopPropagation(); togglePlay(); }}
              className="w-14 h-14 rounded-full bg-primary text-on-primary flex items-center justify-center shadow-lg shadow-primary/20 active:scale-90 transition-transform"
            >
              <span className="material-symbols-outlined text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                {isPlaying ? 'pause_circle' : 'play_circle'}
              </span>
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderHomeView = () => {
    const filteredTopics = topics.filter(topic => 
      topic.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (topic.originalContent && topic.originalContent.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    return (
      <div className="max-w-7xl mx-auto px-6 pt-10 pb-20">
      <div className="mb-12">
        <h1 className="text-4xl md:text-5xl font-black text-on-surface tracking-tight mb-2 font-headline">マイ辞書</h1>
        <p className="text-on-surface-variant text-lg max-w-2xl">ニュースの今を深掘り！ あなたの関心事をパーソナライズされたインテリジェンス・レポートに。</p>
      </div>

      <section className="mb-16">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-bold tracking-tight font-headline">最新のレポート</h2>
          <span className="bg-primary text-on-primary text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full">New Updates</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          {reports.length > 0 && (
            <div 
              onClick={() => {
                const topic = topics.find(t => t.id === reports[0].topicId);
                if(topic) {
                  setSelectedTopic(topic);
                  setCurrentView('detail');
                }
              }}
              className="md:col-span-8 group relative overflow-hidden rounded-2xl bg-surface-container-low p-8 flex flex-col justify-end min-h-[400px] transition-all hover:bg-surface-container-high cursor-pointer"
            >
              <div className="absolute inset-0 z-0 opacity-10 group-hover:scale-105 transition-transform duration-700 bg-gradient-to-br from-primary to-transparent"></div>
              <div className="relative z-10">
                <div className="flex items-center gap-2 mb-4">
                  <span className="bg-on-tertiary-container/10 text-on-tertiary-container text-[11px] font-bold px-2 py-0.5 rounded">最新</span>
                  <span className="text-on-surface-variant text-[11px] font-medium">
                    {formatTimestamp(reports[0].createdAt, "yyyy/MM/dd HH:mm")}
                  </span>
                </div>
                <h3 className="text-3xl font-extrabold text-on-surface leading-tight mb-4 max-w-xl font-headline">
                  {topics.find(t => t.id === reports[0].topicId)?.title || "無題のトピック"}
                </h3>
                <p className="text-on-surface-variant text-base mb-6 max-w-lg line-clamp-2">
                  {reports[0].content}
                </p>
                <button 
                  onClick={(e) => { e.stopPropagation(); handleSelectReport(reports[0]); }}
                  className="bg-gradient-to-br from-primary to-primary-container text-on-primary px-8 py-3.5 rounded-xl font-bold flex items-center gap-2 transition-all active:scale-95 shadow-lg shadow-primary/20"
                >
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>play_circle</span>
                  音声を再生する
                </button>
              </div>
            </div>
          )}
          
          <div className="md:col-span-4 flex flex-col gap-6">
            {reports.length > 1 && (
              <div 
                onClick={() => {
                  const topic = topics.find(t => t.id === reports[1].topicId);
                  if(topic) {
                    setSelectedTopic(topic);
                    setCurrentView('detail');
                  }
                }}
                className="flex-1 bg-surface-container-lowest rounded-2xl p-6 shadow-sm flex flex-col justify-between hover:bg-surface-container-low transition-colors cursor-pointer"
              >
                <div>
                  <span className="text-on-tertiary-container text-[11px] font-bold block mb-2">過去のレポート</span>
                  <h4 className="text-xl font-bold leading-snug font-headline line-clamp-2">
                    {topics.find(t => t.id === reports[1].topicId)?.title || "無題のトピック"}
                  </h4>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs text-on-surface-variant">
                    {formatTimestamp(reports[1].createdAt, "yyyy/MM/dd")}
                  </span>
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleSelectReport(reports[1]); }}
                    className="w-10 h-10 rounded-full bg-secondary-container text-on-secondary-fixed flex items-center justify-center hover:opacity-80 transition-opacity"
                  >
                    <span className="material-symbols-outlined">graphic_eq</span>
                  </button>
                </div>
              </div>
            )}
            
            <div 
              onClick={() => setCurrentView('add')}
              className="flex-1 bg-indigo-50 dark:bg-indigo-950/20 border-2 border-dashed border-indigo-200 dark:border-indigo-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center group cursor-pointer hover:bg-indigo-100 transition-colors"
            >
              <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center text-indigo-600 mb-4 group-hover:scale-110 transition-transform">
                <span className="material-symbols-outlined text-3xl">add</span>
              </div>
              <span className="text-indigo-900 dark:text-indigo-200 font-bold">新しいトピックを追加</span>
              <p className="text-indigo-700/60 dark:text-indigo-400/60 text-xs mt-1">AIがあなた専用のレポートを作成します</p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-10">
          <h2 className="text-2xl font-bold tracking-tight font-headline">登録済みのトピック</h2>
          <div className="relative w-full md:w-64">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/60">search</span>
            <input 
              type="text" 
              placeholder="トピックを検索..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-surface-container-highest border-none rounded-xl focus:ring-2 focus:ring-primary/20 transition-all text-sm text-on-surface placeholder:text-on-surface-variant/40"
            />
          </div>
        </div>
        <div className="space-y-4">
          {filteredTopics.length > 0 ? (
            filteredTopics.map((topic) => {
              const topicReports = reports.filter(r => r.topicId === topic.id);
              return (
                <div 
                  key={topic.id}
                  onClick={() => { setSelectedTopic(topic); setCurrentView('detail'); }}
                  className="bg-surface-container-lowest rounded-2xl p-6 flex flex-col md:flex-row md:items-center gap-6 group hover:translate-x-1 transition-transform cursor-pointer shadow-sm"
                >
                  <div className="w-16 h-16 rounded-xl bg-surface-container flex items-center justify-center shrink-0">
                    <span className="material-symbols-outlined text-3xl text-indigo-400">article</span>
                  </div>
                  <div className="flex-grow">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="text-lg font-bold group-hover:text-primary transition-colors font-headline">{topic.title}</h3>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(topic.id); }}
                      className="p-2 text-on-surface-variant/50 hover:text-error transition-colors"
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                    <span className="material-symbols-outlined text-outline">chevron_right</span>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-12 text-on-surface-variant">
              <span className="material-symbols-outlined text-4xl mb-2 opacity-50">search_off</span>
              <p>見つかりませんでした</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

  const renderAddTopicView = () => (
    <div className="max-w-4xl mx-auto px-6 pt-12 pb-20">
      <section className="mb-12">
        <h2 className="font-headline font-extrabold text-4xl lg:text-5xl text-on-surface tracking-tight mb-4">トピックの登録</h2>
        <p className="text-on-surface-variant text-lg leading-relaxed max-w-2xl">
          ニュースの今を深掘りするために、気になるURLやキーワードを入力してください。AIが詳細なインテリジェンス・レポートを生成します。
        </p>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-6">
          <div className="bg-surface-container-lowest p-8 rounded-[2rem] shadow-sm">
            <form onSubmit={handleRegisterTopic} className="space-y-8">
              <div className="group">
                <label className="block text-sm font-bold text-on-surface-variant mb-3 uppercase tracking-widest px-1">記事のURLを共有</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/60">link</span>
                  <input 
                    name="url"
                    className="w-full h-14 pl-12 pr-4 bg-surface-container-highest border-none rounded-xl focus:ring-2 focus:ring-primary/20 transition-all text-on-surface placeholder:text-on-surface-variant/40" 
                    placeholder="https://example.com/news-article" 
                    type="url"
                    disabled={isRegistering}
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-bold text-on-surface-variant mb-3 uppercase tracking-widest px-1">メモまたはキーワード</label>
                <textarea 
                  name="memo"
                  className="w-full p-5 bg-surface-container-highest border-none rounded-xl focus:ring-2 focus:ring-primary/20 transition-all text-on-surface placeholder:text-on-surface-variant/40 resize-none" 
                  placeholder="特定の視点や、深掘りしたいキーワードを入力してください..." 
                  rows={5}
                  maxLength={10000}
                  disabled={isRegistering}
                ></textarea>
              </div>
              <button 
                type="submit"
                disabled={isRegistering}
                className="w-full h-14 bg-gradient-to-r from-primary to-primary-container text-on-primary font-bold text-lg rounded-xl shadow-lg hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-3 disabled:opacity-50"
              >
                {isRegistering ? (
                  <span className="material-symbols-outlined animate-spin">progress_activity</span>
                ) : (
                  <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                )}
                トピックを登録して分析開始
              </button>
            </form>
          </div>
        </div>
        
        <aside className="lg:col-span-4 space-y-6">
          <div className="bg-surface-container-low p-6 rounded-[2rem] h-full">
            <h3 className="font-headline font-bold text-xl mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">bolt</span>
              最新ニュースを閲覧
            </h3>
            <div className="space-y-4">
              <div className="bg-surface-container-lowest p-4 rounded-2xl hover:bg-white transition-colors cursor-pointer group">
                <div className="text-[10px] font-bold text-on-tertiary-container uppercase mb-2">Technology</div>
                <h4 className="font-bold text-sm leading-tight text-on-surface group-hover:text-primary transition-colors">AI半導体市場の地政学的リスクとその影響</h4>
              </div>
              <div className="bg-surface-container-lowest p-4 rounded-2xl hover:bg-white transition-colors cursor-pointer group">
                <div className="text-[10px] font-bold text-on-tertiary-container uppercase mb-2">Finance</div>
                <h4 className="font-bold text-sm leading-tight text-on-surface group-hover:text-primary transition-colors">中央銀行のデジタル通貨導入に向けた新たな動き</h4>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <section className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="flex flex-col items-center text-center p-6">
          <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-primary">share</span>
          </div>
          <h5 className="font-bold mb-2">URL共有</h5>
          <p className="text-sm text-on-surface-variant">ブラウザの共有メニューから直接このアプリにURLを飛ばすことができます。</p>
        </div>
        <div className="flex flex-col items-center text-center p-6">
          <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-primary">psychology</span>
          </div>
          <h5 className="font-bold mb-2">AI分析</h5>
          <p className="text-sm text-on-surface-variant">登録されたトピックは即座にAIが読み込み、重要な論点を整理します。</p>
        </div>
        <div className="flex flex-col items-center text-center p-6">
          <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-primary">history</span>
          </div>
          <h5 className="font-bold mb-2">履歴保存</h5>
          <p className="text-sm text-on-surface-variant">一度登録したトピックはマイ・ドシエに保存され、いつでも再確認可能です。</p>
        </div>
      </section>
    </div>
  );

  const renderTopicDetailView = () => {
    if (!selectedTopic) return null;
    const topicReports = reports.filter(r => r.topicId === selectedTopic.id);

    return (
      <div className="max-w-4xl mx-auto px-6 pt-10 pb-32">
        <section className="mb-12">
          <div className="flex items-center justify-between mb-4">
            <span className="bg-secondary-container text-on-secondary-fixed text-xs font-bold px-3 py-1 rounded-full uppercase tracking-widest">Active Intelligence</span>
            <span className="text-on-surface-variant text-sm font-medium">
              登録日: {formatTimestamp(selectedTopic.createdAt, "yyyy年MM月dd日")}
            </span>
          </div>
          <h2 className="font-headline text-4xl md:text-5xl font-extrabold text-on-surface leading-tight tracking-tight mb-6">
            {selectedTopic.title}
          </h2>
          <div className="flex flex-wrap gap-4">
            <button 
              onClick={() => handleRefreshTopic(selectedTopic)}
              disabled={isGenerating}
              className="bg-gradient-to-br from-primary to-primary-container text-white px-8 py-4 rounded-xl flex items-center gap-2 font-bold shadow-lg transition-all active:scale-95 disabled:opacity-50"
            >
              <span className={cn("material-symbols-outlined", isGenerating && "animate-spin")}>refresh</span>
              今すぐ再リサーチ
            </button>
            <button 
              onClick={() => setDeleteConfirmId(selectedTopic.id)}
              className="bg-error-container text-on-error-container px-6 py-4 rounded-xl flex items-center gap-2 font-bold hover:opacity-90 transition-colors"
            >
              <span className="material-symbols-outlined">delete</span>
              削除
            </button>
          </div>
        </section>

        <div className="flex items-center gap-4 mb-8">
          <div className="h-[2px] flex-grow bg-outline-variant/30"></div>
          <h3 className="font-headline font-bold text-lg text-primary tracking-widest uppercase">Chronological Intelligence</h3>
          <div className="h-[2px] flex-grow bg-outline-variant/30"></div>
        </div>

        <div className="relative space-y-12">
          <div className="absolute left-6 top-4 bottom-4 w-0.5 bg-outline-variant/20 hidden md:block"></div>
          
          {topicReports.map((report, index) => (
            <div key={report.id} className="relative pl-0 md:pl-16 group">
              <div className={cn(
                "absolute left-4 md:left-5 top-0 w-3 h-3 rounded-full border-4 border-surface z-10",
                index === 0 ? "bg-primary shadow-[0_0_0_8px_rgba(0,6,102,0.05)]" : "bg-outline-variant"
              )}></div>
              <div className={cn(
                "rounded-2xl p-6 md:p-8 transition-all",
                index === 0 ? "bg-surface-container-lowest shadow-sm hover:shadow-md group-hover:bg-white border border-transparent hover:border-primary/5" : "bg-surface-container-low/50 hover:bg-surface-container-low"
              )}>
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-3">
                      <span className={cn("font-bold text-sm tracking-wide font-headline", index === 0 ? "text-primary" : "text-on-surface-variant")}>AI UPDATE</span>
                      <span className="text-on-surface-variant text-sm">
                        • {formatTimestamp(report.createdAt, "yyyy年MM月dd日 HH:mm")}
                      </span>
                    </div>
                    <div className="prose prose-sm max-w-none text-on-surface-variant leading-relaxed mb-6 line-clamp-3">
                      <Markdown>{report.content}</Markdown>
                    </div>
                    <div className="flex items-center gap-4">
                      <button 
                        onClick={() => handleSelectReport(report)}
                        className={cn(
                          "w-14 h-14 rounded-2xl flex items-center justify-center transition-all hover:scale-105 active:scale-90",
                          index === 0 ? "bg-indigo-50 dark:bg-indigo-900/40 text-indigo-900 dark:text-indigo-100 shadow-sm" : "bg-surface-container-highest text-on-surface-variant"
                        )}
                      >
                        <span className="material-symbols-outlined text-3xl" style={{ fontVariationSettings: index === 0 ? "'FILL' 1" : "'FILL' 0" }}>play_arrow</span>
                      </button>
                      <div>
                        <span className="block text-xs font-bold text-on-surface-variant uppercase tracking-tighter">Audio briefing</span>
                        <span className={cn("font-semibold tracking-tight", index === 0 ? "text-on-surface" : "text-on-surface-variant")}>
                          {report.audioData ? "聴取可能" : "生成中..."}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Original Content */}
          <div className="relative pl-0 md:pl-16 group">
            <div className="absolute left-4 md:left-5 top-0 w-3 h-3 rounded-full bg-tertiary-container border-4 border-surface z-10"></div>
            <div className="bg-tertiary-container/5 rounded-2xl p-6 md:p-8 border-l-4 border-tertiary-container">
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-outlined text-on-tertiary-container text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>stars</span>
                <span className="text-on-tertiary-container font-bold text-sm tracking-wide font-headline">ORIGINAL CONTENT</span>
                <span className="text-on-surface-variant text-sm">
                  • {formatTimestamp(selectedTopic.createdAt, "yyyy年MM月dd日")}
                </span>
              </div>
              <h4 className="font-headline text-2xl font-bold mb-4 text-on-surface">リサーチ開始</h4>
              <p className="text-on-surface-variant text-lg leading-relaxed mb-6">
                {selectedTopic.originalContent}
              </p>
              {selectedTopic.url && (
                <div className="flex items-center gap-4">
                  <a href={selectedTopic.url} target="_blank" rel="noopener noreferrer" className="px-6 py-2 bg-white text-on-surface font-bold rounded-lg shadow-sm border border-outline-variant/20 hover:bg-surface-container transition-colors inline-block">
                    元のソースを確認
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderPlayerView = () => {
    if (!activeReport) return null;
    const topic = topics.find(t => t.id === activeReport.topicId);

    return (
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-32">
        <section className="mb-10 grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
          <div className="md:col-span-5 aspect-square rounded-[2rem] overflow-hidden shadow-2xl relative group bg-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined text-9xl text-white/20">graphic_eq</span>
            <div className="absolute inset-0 bg-gradient-to-t from-primary/60 to-transparent"></div>
            <div className="absolute bottom-6 left-6 right-6">
              <span className="inline-block px-3 py-1 bg-white/20 backdrop-blur-md rounded-full text-white text-xs font-bold tracking-widest uppercase mb-2">Analysis</span>
              <h2 className="text-white font-headline font-extrabold text-2xl leading-tight line-clamp-2">{topic?.title}</h2>
            </div>
          </div>
          <div className="md:col-span-7 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-on-surface-variant font-semibold text-sm tracking-wide">
                {formatTimestamp(activeReport.createdAt, "yyyy.MM.dd HH:mm")}
              </span>
              <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-container-high rounded-full">
                <span className="material-symbols-outlined text-[18px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>radio</span>
                <span className="text-xs font-bold text-primary tracking-tight">連続再生 {radioMode ? "ON" : "OFF"}</span>
              </div>
            </div>
            <h3 className="text-3xl font-headline font-black text-on-surface leading-tight">
              インサイト・レポート
            </h3>
          </div>
        </section>

        <section className="mb-12 flex flex-col items-center gap-8">
          <div className="flex items-center justify-center gap-10">
            <button 
              onClick={() => { if(currentAudio) currentAudio.currentTime -= 5; }}
              className="w-14 h-14 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-low transition-all active:scale-90"
            >
              <span className="material-symbols-outlined text-3xl">replay_5</span>
            </button>
            <button 
              onClick={togglePlay}
              className="w-24 h-24 flex items-center justify-center rounded-[2rem] bg-gradient-to-br from-primary to-primary-container text-white shadow-xl hover:shadow-2xl transition-all active:scale-95 group"
            >
              <span className="material-symbols-outlined text-5xl" style={{ fontVariationSettings: "'FILL' 1" }}>
                {isPlaying ? 'pause' : 'play_arrow'}
              </span>
            </button>
            <button 
              onClick={() => { if(currentAudio) currentAudio.currentTime += 30; }}
              className="w-14 h-14 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-low transition-all active:scale-90"
            >
              <span className="material-symbols-outlined text-3xl">forward_30</span>
            </button>
          </div>
          
          <div className="flex flex-wrap items-center justify-center gap-4">
            <div className="flex bg-surface-container-low p-1.5 rounded-2xl">
              {[1.0, 1.5, 2.0].map(speed => (
                <button 
                  key={speed}
                  onClick={() => {
                    setPlaybackSpeed(speed);
                    if (currentAudio) currentAudio.playbackRate = speed;
                  }}
                  className={cn(
                    "px-5 py-2.5 text-xs font-black rounded-xl transition-colors",
                    playbackSpeed === speed ? "bg-white shadow-sm text-primary" : "text-on-surface-variant hover:text-primary"
                  )}
                >
                  {speed}x
                </button>
              ))}
            </div>
            <div className="h-10 w-[1px] bg-outline-variant/30 hidden sm:block mx-2"></div>
            <button 
              onClick={() => setRadioMode(!radioMode)}
              className={cn(
                "flex items-center gap-3 px-6 py-3 rounded-2xl font-bold transition-all active:scale-95",
                radioMode ? "bg-secondary-container text-on-secondary-fixed" : "bg-surface-container text-on-surface-variant"
              )}
            >
              <span className="material-symbols-outlined text-xl">settings_input_antenna</span>
              <span className="text-sm">ラジオモード</span>
              <div className={cn("w-10 h-6 rounded-full relative flex items-center px-1 transition-colors", radioMode ? "bg-primary-container" : "bg-outline")}>
                <div className={cn("w-4 h-4 bg-white rounded-full transition-transform", radioMode ? "translate-x-4" : "translate-x-0")}></div>
              </div>
            </button>
          </div>
        </section>

        <section className="bg-surface-container-lowest rounded-[2.5rem] p-8 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <h4 className="font-headline font-extrabold text-xl text-indigo-950">レポート要約</h4>
          </div>
          <div className="space-y-8 h-80 overflow-y-auto pr-4 hide-scrollbar prose prose-sm max-w-none text-on-surface">
            <Markdown>{activeReport.content}</Markdown>
          </div>
        </section>
      </div>
    );
  };

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen pb-32">
      {renderTopAppBar()}
      
      <AnimatePresence mode="wait">
        <motion.div
          key={currentView}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.2 }}
        >
          {currentView === 'home' && renderHomeView()}
          {currentView === 'add' && renderAddTopicView()}
          {currentView === 'detail' && renderTopicDetailView()}
          {currentView === 'player' && renderPlayerView()}
        </motion.div>
      </AnimatePresence>

      {renderMiniPlayer()}
      {renderBottomNavBar()}
      <Toaster position="top-center" richColors />
      <AnimatePresence>
        {renderDeleteConfirmation()}
      </AnimatePresence>

      <AnimatePresence>
        {isGenerating && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-6"
          >
            <div className="bg-white rounded-3xl p-8 max-w-sm w-full text-center shadow-2xl">
              <div className="w-16 h-16 bg-primary-container rounded-2xl flex items-center justify-center mx-auto mb-6">
                <span className="material-symbols-outlined animate-spin text-on-primary text-3xl">progress_activity</span>
              </div>
              <h3 className="text-xl font-bold text-on-surface mb-2 font-headline">AIがリサーチ中...</h3>
              <p className="text-on-surface-variant text-sm">
                最新の情報を収集し、インサイトを抽出しています。<br/>しばらくお待ちください。
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
