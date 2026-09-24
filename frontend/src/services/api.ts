import { auth } from "../firebase";

const API_URL = "http://localhost:8000";

export async function getTasks() {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("User is not logged in");
  }

  const idToken = await user.getIdToken();

  const response = await fetch(`${API_URL}/tasks`, {
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch tasks");
  }

  return response.json();
}