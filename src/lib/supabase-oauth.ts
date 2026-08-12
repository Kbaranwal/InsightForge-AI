import { supabase } from "@/integrations/supabase/client";

/**
 * Typed wrapper around the beta `supabase.auth.oauth` namespace.
 * Lives outside the route file: TanStack's route splitting hoists module-scope
 * consts out of route modules, which broke the client bundle when this was
 * declared inline in the consent route.
 */
export type OAuthClient = {
  name?: string;
  client_name?: string;
  redirect_uri?: string;
  scope?: string;
};

export type OAuthAuthDetails = {
  client?: OAuthClient;
  scope?: string;
  redirect_url?: string;
  redirect_to?: string;
};

type OAuthResult<T> = { data: T | null; error: { message: string } | null };

export type OAuthApi = {
  getAuthorizationDetails: (id: string) => Promise<OAuthResult<OAuthAuthDetails>>;
  approveAuthorization: (
    id: string,
  ) => Promise<OAuthResult<{ redirect_url?: string; redirect_to?: string }>>;
  denyAuthorization: (
    id: string,
  ) => Promise<OAuthResult<{ redirect_url?: string; redirect_to?: string }>>;
};

export function getOAuthApi(): OAuthApi {
  return (supabase.auth as unknown as { oauth: OAuthApi }).oauth;
}
