import { AuthApiError } from "@/api";

export type ManagedAuthMode = "signin" | "signup";
export type ManagedAuthField = "name" | "email" | "password";

export type ManagedAuthFormErrors = Partial<Record<ManagedAuthField, string>>;

export type ManagedAuthFailure = {
  fields: ManagedAuthFormErrors;
  message: string | null;
  switchTo: ManagedAuthMode | null;
};

export class ManagedAuthSessionUnavailableError extends Error {
  constructor(readonly mode: ManagedAuthMode) {
    super(
      mode === "signup"
        ? "Account created without an active browser session"
        : "Sign-in completed without an active browser session",
    );
    this.name = "ManagedAuthSessionUnavailableError";
  }
}

export function validManagedAuthEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= 320 && email.includes("@") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
}

export function validateManagedAuthInput(
  mode: ManagedAuthMode,
  input: { name: string; email: string; password: string },
): ManagedAuthFormErrors {
  const errors: ManagedAuthFormErrors = {};
  if (mode === "signup" && !input.name.trim()) {
    errors.name = "Enter your name.";
  }
  if (!input.email.trim()) {
    errors.email = "Enter your email address.";
  } else if (!validManagedAuthEmail(input.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (!input.password) {
    errors.password = "Enter your password.";
  } else if (mode === "signup" && input.password.length < 8) {
    errors.password = "Choose a password with at least 8 characters.";
  }
  return errors;
}

export function managedAuthFailure(mode: ManagedAuthMode, error: unknown): ManagedAuthFailure {
  if (error instanceof ManagedAuthSessionUnavailableError) {
    return {
      fields: {},
      message:
        error.mode === "signup"
          ? "Your account was created, but we couldn't start your session. Switch to sign in and use the password you just chose."
          : "Your details were accepted, but we couldn't start your session. Please try again.",
      switchTo: error.mode === "signup" ? "signin" : null,
    };
  }

  if (error instanceof AuthApiError) {
    if (error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
      return {
        fields: { email: "An account already exists for this email." },
        message: "Sign in with this email instead, or use a different email address.",
        switchTo: "signin",
      };
    }
    if (error.code === "INVALID_EMAIL_OR_PASSWORD") {
      return {
        fields: {},
        message: "Email or password is incorrect.",
        switchTo: null,
      };
    }
    if (
      error.code === "VALIDATION_ERROR" &&
      (error.field === "email" || /email/i.test(error.message))
    ) {
      return {
        fields: { email: "Enter a valid email address." },
        message: null,
        switchTo: null,
      };
    }
    if (
      error.code === "VALIDATION_ERROR" &&
      (error.field === "password" || /password/i.test(error.message))
    ) {
      return {
        fields: {
          password:
            mode === "signup"
              ? "Choose a password with at least 8 characters."
              : "Enter a valid password.",
        },
        message: null,
        switchTo: null,
      };
    }
    if (error.status === 429) {
      return {
        fields: {},
        message: "Too many attempts. Wait a moment and try again.",
        switchTo: null,
      };
    }
  }

  return {
    fields: {},
    message:
      mode === "signup"
        ? "We couldn't create your account. Please try again."
        : "We couldn't sign you in. Please try again.",
    switchTo: null,
  };
}
