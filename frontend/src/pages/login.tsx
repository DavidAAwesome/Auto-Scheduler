import {
  signInWithEmailAndPassword,
} from "firebase/auth";

import { auth } from "../firebase";

async function login(email: string, password: string) {
  try {
    const userCredential =
      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

    const user = userCredential.user;

    console.log("Logged in:", user.uid);
  } catch (error) {
    console.error(error);
  }
}