import { pageTitle } from '../../../shared/page-titles';
import { PRIVACY_NOTICE } from '../../../shared/privacy';
import { CREDIT_EMAIL, CREDIT_EMAIL_HREF, CREDIT_NAME, CREDIT_SITE, CREDIT_SITE_HREF } from '../brand';
import { TextPage } from './About';

const list = 'list-disc space-y-1 pl-5';
const cookie = 'font-mono text-[0.85em]';

/**
 * The privacy notice (UI_DESIGN §4.8, DESIGN §7), approved by the owner on 24 October 2026 and
 * amended on 31 October 2026 to say that Claude also orders the investigations found. The Task 25
 * statements are the controller's wording after the security review (condition 2), published with
 * Task 25 on 31 October 2026 while the owner's approval is pending (controller ruling, so the
 * features never run without an accurate notice): a rating kept with its search for the search's 24
 * hours and on the search's trace (30 days, which AirCase can match to the search while the search
 * is kept), daily rating totals linked to no one and kept with no set end, cost and search-usage
 * records without content for 90 days (a deleted account's too), trace backups for 7 days and
 * application backups for 14, which can outlast a deletion, measuring search quality as a
 * legitimate interest, and the operator's view of each account's details and AI search counts on a
 * private admin page.
 * Publishing it (`PRIVACY_NOTICE.final`, shared/privacy.ts) is what lets live turn Google sign-in
 * on. Every statement was checked against the code: change the text, and its date, in the same
 * commit as any change to what the site keeps or who receives it. It keeps the Turnstile
 * paragraph (a third party an AI request loads; Task 22 review W-14) and the retry key kept while
 * a search is on its way (W-2). The AI section describes the evidence view as designed: one
 * scope call and one query embedding per search, results kept 24 hours for their owner only.
 */
export function Privacy() {
  return (
    <TextPage eyebrow="Privacy" title="Privacy" tabTitle={pageTitle({ kind: 'privacy' })}>
      <p>
        AirCase is a non-commercial site for searching and comparing NTSB accident investigations. It has no ads, no
        analytics and no tracking scripts or cookies. Searching, reading cases, comparing and the dashboard need no
        account.
      </p>

      <h2>Who is responsible</h2>
      <p>
        {CREDIT_NAME}, a private individual in the Czech Republic, runs AirCase and decides how its data is used (the
        GDPR “controller”). Contact:{' '}
        <a href={CREDIT_EMAIL_HREF} className="link">
          {CREDIT_EMAIL}
        </a>
        ; website:{' '}
        <a href={CREDIT_SITE_HREF} target="_blank" rel="noopener noreferrer" className="link">
          {CREDIT_SITE}
        </a>
        .
      </p>

      <h2>On your device</h2>
      <p>
        Your Day or Night choice is kept in this browser’s local storage. Signing out also leaves a random value there,
        which says nothing about you, so other open tabs forget what they showed. While an AI search is on its way, and
        if it gets no reply, this tab’s session storage keeps a one-way hash of the request, a random retry key and the
        time, so a retry within 24 hours isn’t counted twice.
      </p>
      <p>The site’s own cookies, which page scripts cannot read:</p>
      <ul className={list}>
        <li>
          <code className={cookie}>__Host-aviation_trial</code> (30 days): set by your first AI search without an
          account; a random ID used only to count and limit your free searches and to show each AI result to you alone.
        </li>
        <li>
          <code className={cookie}>__Host-aviation_session</code> (7 days, never extended): keeps you signed in.
        </li>
        <li>
          <code className={cookie}>__Host-aviation_oauth_state</code> (10 minutes): protects a sign-in in progress.
        </li>
        <li>
          <code className={cookie}>__Secure-aviation_signout</code> (up to 7 days): set only if our server couldn’t
          confirm a sign-out, to finish it later.
        </li>
      </ul>
      <p>
        Asking the AI loads Cloudflare Turnstile, a check that a person is asking, from challenges.cloudflare.com, but
        only when an AI request needs a check: always without an account, sometimes when signed in, never for searching
        or reading. It is Cloudflare’s own script and frame, and Cloudflare may set its own cookies for it.
      </p>

      <h2>On our servers</h2>
      <p>
        AirCase runs on its operator’s own computer in the Czech Republic, behind Cloudflare. The server holds your IP
        address only in memory, to limit how many requests one network can send, and never saves it. Logs hold only
        technical events, such as each request’s type, result and duration. Keyword searches, case pages and the
        dashboard are not stored or tied to you. Search traces (timings, counts, AI cost and errors, and a search’s
        rating if you give one) hold no search words or identities; for the 24 hours a search is kept, AirCase can match
        it to its trace.
      </p>

      <h2>Accounts</h2>
      <p>
        An account is optional and gives you more AI searches. Google sign-in gives us your Google account ID, verified
        e-mail address and basic profile; we keep the ID, e-mail address and name as they were at your first sign-in,
        and nothing else from Google. The site’s operator can see each account’s name, e-mail address, sign-up and last
        sign-in times and AI search counts on a private admin page. Sessions are stored without your IP address or
        browser details. We send no e-mail.
      </p>
      <p>
        You can delete your account on the Account page, after confirming with Google if you signed in over 5 minutes
        ago. This signs you out everywhere and at once removes your name, e-mail address, Google link and your account’s
        AI searches. Two records stay, under a one-way code: the account’s AI search counts, so signing up again doesn’t
        reset its limits, and cost and search-usage records without content.
      </p>

      <h2>AI searches</h2>
      <p>
        Our server sends the text of your AI search to Anthropic, whose Claude model turns it into search filters and
        terms and puts the investigations found in order of relevance, and to OpenAI, which turns it into numbers (an “embedding”) for finding passages of similar meaning.
        Neither gets anything else about you, but please keep personal details out of your questions. Results are NTSB
        text and data, not AI-written summaries. Your question, filters and results are kept 24 hours, then deleted;
        only your browser or account can open them. If you rate an AI search, AirCase keeps the rating with that search
        for its 24 hours and adds it to the search’s trace; it also counts it in daily totals that aren’t linked to you
        or your search, to measure search quality.
      </p>
      <p>
        To stop abuse and share free searches fairly, we count AI searches per browser, account and network, under keyed
        one-way codes.
      </p>

      <h2>Who else processes data</h2>
      <ul className={list}>
        <li>
          <b>Cloudflare</b> carries and protects all traffic to AirCase. It sees your IP address and what you request,
          search words included, and runs Turnstile.
        </li>
        <li>
          <b>Google</b> handles sign-in, under its own privacy policy.
        </li>
        <li>
          <b>Anthropic</b> and <b>OpenAI</b> get the text of AI searches. Under their current terms they keep it up to
          30 days (longer only for misuse investigations or by law) and don’t train models on it.
        </li>
      </ul>
      <p>
        All four are US companies, so data they receive may be processed outside the EU, under the safeguards in their
        data-protection terms.
      </p>

      <h2>How long data is kept</h2>
      <ul className={list}>
        <li>AI searches, with their ratings, and their retry records: 24 hours.</li>
        <li>Daily rating totals, not linked to you or a search: kept with no set end.</li>
        <li>Free-search records: 30 days.</li>
        <li>Sessions: 7 days, or until you sign out.</li>
        <li>Accounts: until you delete them.</li>
        <li>Usage counters (a deleted account’s too): until 7 days after their minute, hour, day or month ends.</li>
        <li>Cost and search-usage records, without content (a deleted account’s too): 90 days.</li>
        <li>Traces, with any rating on them: 30 days.</li>
        <li>
          Backups: daily, kept 14 days on the same computer. They hold counters, free-search, cost and search-usage
          records and daily rating totals, never accounts, sessions or AI searches, so deleted accounts can’t return.
          Trace backups are kept 7 days. A backup can keep data for those days after it is deleted from the site.
        </li>
      </ul>

      <h2>Why we may use it</h2>
      <p>
        Running and securing the site, and measuring search quality (Cloudflare, Turnstile, limits, counters, logs,
        traces, ratings, backups), relies on our legitimate interest in a safe, working, affordable site; accounts and AI
        searches rely on providing the service you asked for.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask for access, correction, deletion or a portable copy of your data, and object to or restrict its use.
        The Account page shows your details and lets you delete your account; for anything else, write to{' '}
        <a href={CREDIT_EMAIL_HREF} className="link">
          {CREDIT_EMAIL}
        </a>{' '}
        and we’ll reply within a month. Without an account, your data sits under one-way codes we can’t link to you, so
        we may not find it. You can also complain to the Czech data protection authority, Úřad pro ochranu osobních
        údajů (
        <a href="https://uoou.gov.cz" target="_blank" rel="noopener noreferrer" className="link">
          uoou.gov.cz
        </a>
        ).
      </p>

      <h2>Changes</h2>
      <p>We’ll update this page and its date if anything here changes.</p>
      <p className="font-sans text-meta text-muted">Last updated: 31 October 2026</p>

      {!PRIVACY_NOTICE.final && (
        <p className="font-sans text-meta text-muted">
          Draft notice. The final privacy text is published before accounts or AI searches are offered.
        </p>
      )}
    </TextPage>
  );
}
