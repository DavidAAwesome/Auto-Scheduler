import {
  createUserWithEmailAndPassword,
} from "firebase/auth";

import { auth } from "../firebase";

async function register(email: string, password: string) {
  try {
    const userCredential =
      await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

    const user = userCredential.user;

    console.log("Created user:", user.uid);
  } catch (error) {
    console.error(error);
  }
}