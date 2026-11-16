import { permanentRedirect } from "next/navigation";

// /door (Graduation watch) was retired: old links land on the launch board.
export default function DoorRedirect() {
  permanentRedirect("/");
}
