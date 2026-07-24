import { redirect } from "next/navigation";

export default function Home() {
  // Clients is the app's home since the flat racks list was retired (PR #49) —
  // /racks no longer exists, so the old redirect landed every visit to "/" on a 404.
  redirect("/clients");
}
