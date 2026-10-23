import { PRIVACY_NOTICE } from '../../../shared/privacy';
import { TextPage } from './About';

/**
 * Privacy notice, plain language (UI_DESIGN §4.8, DESIGN §7). This covers what the
 * site does today; the owner provides the final text before accounts and AI
 * searches open, and sets `PRIVACY_NOTICE.final` (shared/privacy.ts) with it: until
 * then the page says it is a draft and live keeps Google sign-in off.
 */
export function Privacy() {
  return (
    <TextPage eyebrow="Privacy" title="Privacy">
      <p>
        Searching, reading cases, comparing and the dashboard need no account. The site sets no tracking or advertising
        cookies.
      </p>
      <h2>On your device</h2>
      <p>
        If you choose Day or Night, that choice is kept in your browser’s local storage on this device only. Signing out
        or deleting your account also leaves a random value there, so that the site’s other open tabs forget what they
        showed you; it says nothing about you. If an AI search gets no reply, this tab’s session storage keeps a one-way
        hash of the request and a random retry key, so trying again within 24 hours isn’t counted twice. Your first AI
        search also sets a cookie that holds a random ID for 30 days; the site uses it only to count and limit your free
        searches and to show each AI answer to you alone, and scripts on the page cannot read it.
      </p>
      <h2>On our servers</h2>
      <p>
        Like any website, the server sees each request, including your network address. Request logs are kept for a short,
        fixed period for security and are not used to profile you. Searches you run are not tied to you.
      </p>
      <h2>AI searches and accounts</h2>
      <p>
        AI searches and Google sign-in are not open yet. Before they are, this page will set out exactly what is kept: an
        account ID, email and name for signed-in users, and questions and answers held for up to 24 hours to deliver them,
        then deleted.
      </p>
      {!PRIVACY_NOTICE.final && (
        <p className="font-sans text-meta text-muted">
          Draft notice. The final privacy text is published before accounts or AI searches are offered.
        </p>
      )}
    </TextPage>
  );
}
