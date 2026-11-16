import { permanentRedirect } from "next/navigation";

// /map (roadmap) was retired: old links land on the launch board.
export default function MapRedirect() {
  permanentRedirect("/");
}
