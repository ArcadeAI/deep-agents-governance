/**
 * The identity half of a user, in Okta, for `bun run users`.
 *
 * Somebody this command creates is put in {@link USERS_GROUP}, and that
 * membership is the only thing that lets `remove` delete them from the org
 * again. Anybody else, the org's own admin above all, is somebody `add` may
 * give a role to and `remove` takes the role from, and their Okta account is
 * never touched.
 *
 * Passwords are checked here against Okta's default password policy before
 * anything is sent, so a refusal names the rule rather than arriving as a 400
 * after the subject was written. An org with a stricter policy still refuses
 * in Okta, and that refusal is passed through word for word.
 */
import { Okta, type OktaGroup, type OktaUser, apiToken, orgUrlFrom } from "./client.ts";
import { USERS_GROUP } from "./setup.ts";

export interface Person {
  id: string;
  email: string;
  name: string;
  /** Okta's status: `ACTIVE` signs in; `STAGED`, `PROVISIONED`, `SUSPENDED` and the rest do not. */
  status: string;
  /** In {@link USERS_GROUP}: created by `bun run users`, so `remove` deletes them. */
  ours: boolean;
}

/** What `remove` did on the Okta side. */
export type Removal = "deleted" | "kept" | null;

/**
 * Okta's default password policy, as a new org ships it: at least 8
 * characters, a lowercase letter, an uppercase letter and a number, and no
 * part of the username. Symbols are not required by default.
 */
export const PASSWORD_MIN = 8;
/** A conservative ceiling: Okta hashes passwords with bcrypt, which reads 72 bytes. */
export const PASSWORD_MAX = 72;

/** The parts of a login Okta's "no part of the username" rule looks for: split on `. , - _ # @`, three characters or more. */
function usernameParts(email: string): string[] {
  return email
    .toLowerCase()
    .split(/[.,\-_#@]/)
    .filter((part) => part.length >= 3);
}

/** Why Okta's default policy would refuse `password` for `email`, or `null` when it would not. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return `must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`;
  if (!/[a-z]/.test(password)) return "needs a lowercase letter";
  if (!/[A-Z]/.test(password)) return "needs an uppercase letter";
  if (!/[0-9]/.test(password)) return "needs a number";
  const lower = password.toLowerCase();
  const part = usernameParts(email).find((each) => lower.includes(each));
  if (part !== undefined) return `must not contain part of the username ("${part}")`;
  return null;
}

/**
 * 20 characters from 62, about 119 bits, drawn without modulo bias, and
 * redrawn until Okta's default policy would take it for `email`.
 */
export function generatePassword(email: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (;;) {
    let out = "";
    while (out.length < 20) {
      for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
        if (byte < 248 && out.length < 20) out += alphabet[byte % 62];
      }
    }
    if (passwordProblem(out, email) === null) return out;
  }
}

/**
 * Okta's profile wants a first and a last name. A one-word name, as the demo
 * cast has, keeps it as the first name, with "Loan Desk" as the last, so the
 * Admin Console shows where they came from.
 */
export function splitName(name: string): { firstName: string; lastName: string } {
  const words = name.trim().split(/\s+/);
  if (words.length < 2) return { firstName: words[0] ?? name, lastName: "Loan Desk" };
  return { firstName: words.slice(0, -1).join(" "), lastName: words.at(-1)! };
}

function nameOf(user: OktaUser): string {
  const { firstName = "", lastName = "" } = user.profile;
  return lastName === "Loan Desk" ? firstName : `${firstName} ${lastName}`.trim();
}

export class OktaPeople {
  #group: OktaGroup | null = null;

  constructor(readonly okta: Okta) {}

  /** The users group, made on first use if `okta-setup` has not made it yet. */
  async group(): Promise<OktaGroup> {
    this.#group ??= (await this.okta.ensureGroup(USERS_GROUP, "People added by bun run users in the Loan Desk workshop")).group;
    return this.#group;
  }

  async find(email: string): Promise<Person | null> {
    const user = await this.okta.findUser(email);
    if (user === null) return null;
    const group = await this.group();
    return this.#person(user, await this.okta.inGroup(group.id, user.id));
  }

  /** Created active with the password, then put in the group. A failure after the create deletes them again. */
  async add(person: { name: string; email: string; password: string }): Promise<Person> {
    const group = await this.group();
    const user = await this.okta.createUser({ email: person.email, password: person.password, ...splitName(person.name) });
    try {
      await this.okta.addToGroup(group.id, user.id);
    } catch (cause) {
      await this.okta.deleteUser(user.id).catch(() => undefined);
      throw cause;
    }
    return this.#person(user, true);
  }

  /** Deleted when this command created them; otherwise left as they are. */
  async remove(email: string): Promise<Removal> {
    const found = await this.find(email);
    if (found === null) return null;
    if (!found.ours) return "kept";
    await this.okta.deleteUser(found.id);
    return "deleted";
  }

  /** Everybody in the users group. */
  async list(): Promise<Person[]> {
    const group = await this.group();
    return (await this.okta.groupMembers(group.id)).map((user) => this.#person(user, true));
  }

  #person(user: OktaUser, ours: boolean): Person {
    return { id: user.id, email: (user.profile.email || user.profile.login).toLowerCase(), name: nameOf(user), status: user.status, ours };
  }
}

/** The org from `OKTA_ORG_URL` (or `IDP_ISSUER`'s origin) and the token from `OKTA_API_TOKEN`. */
export function openOktaPeople(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): OktaPeople {
  return new OktaPeople(new Okta({ orgUrl: orgUrlFrom(env), token: apiToken(env), ...(fetchImpl ? { fetch: fetchImpl } : {}) }));
}
