import { permanentRedirect } from "next/navigation";

// /kit (press kit) was retired: old links land on the launch board.
export default function KitRedirect() {
  permanentRedirect("/");
}
