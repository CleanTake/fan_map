export type AuthRole = "admin" | "registered";

// Guests have no account or session; a null user represents a guest.
export type AuthUser = {
  id: string;
  email: string;
  role: AuthRole;
};
