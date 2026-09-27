// The cinema's analysis and result presentation, handed to the shared
// feature components through features/analysis/cinema-copy.ts. Only the cinema
// app provides it (main-cinema.tsx); develop's screens get null and keep their
// words and behaviour.
import { cinemaDevTools } from "./dev-tools";
import * as format from "./format";
import { AcceptedResult } from "./results/AcceptedResult";
import { CinemaDataDetails } from "./results/DataDetails";
import { CinemaHistoryDetail } from "./results/HistoryDetail";
import { CinemaSignalName } from "./results/SignalName";
import { CinemaStarResult } from "./results/StarResult";
import "./periodogram.css";

export const cinemaAnalysisCopy = {
  /** Numbers, names and words (./format.ts). */
  format,
  /** Developer tools on this dev server (VITE_CINEMA_DEV_TOOLS). */
  devTools: cinemaDevTools,
  /** Body and actions of an accepted result in the classic result dialog. */
  AcceptedResult,
  /** `/results/:ticId` content. */
  StarResult: CinemaStarResult,
  /** `/history/:historyId` content. */
  HistoryDetail: CinemaHistoryDetail,
  /** The classic "데이터 상세" body. */
  DataDetails: CinemaDataDetails,
  /** A signal by its star-panel name ("행성 2 (주기 11.73일)"). */
  SignalName: CinemaSignalName,
};

export type CinemaAnalysisCopy = typeof cinemaAnalysisCopy;
