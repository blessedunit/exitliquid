import { permanentRedirect } from "next/navigation";

// The points leaderboard was retired (17.10): /board lands on the $EXIT page.
export default function BoardRedirect() {
  permanentRedirect("/exit");
}
