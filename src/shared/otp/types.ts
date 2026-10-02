export type OtpProviderName = 'msg91' | 'slide' | 'fake';

/** Who is logging in. MSG91 keeps a separate account (authkey) per audience; Slide does not. */
export type OtpAudience = 'consumer' | 'retailer' | 'driver' | 'crm';

/** Shape of the phone returned to the login controllers. */
export type OtpPhoneFormat = 'national' | 'e164';

export interface OtpProvider {
  readonly name: OtpProviderName;
  /**
   * Re-verify an access token the client obtained from the provider and return the phone
   * number the provider attests was verified, as digits INCLUDING the country code
   * (e.g. "919876543210").
   *
   * @throws AppError 503 not configured, 502 provider unreachable, 401 token not valid.
   */
  verifyAccessToken(accessToken: string, audience: OtpAudience): Promise<string>;
}
