# Rotating your Claude token (optional)

**What happened:** while checking a sandbox's state, I called E2B's sandbox-details endpoint. Its response includes
the sandbox's egress rules, and those carry your Claude token. I printed the first 600 characters of the response,
so a large part of the token (from `sk-ant-oat01-…`) ended up in my session log on the Outerloop machine. It went
nowhere else, and since then I read only the state field. Because the output was cut short, the printed part is
probably not the whole token. Rotating removes the doubt.

**Steps**

1. On any machine with Claude Code installed, run `claude setup-token`, sign in with the Claude account Dream should
   use, and copy the `sk-ant-oat01-…` token it prints. Don't paste it anywhere else.
2. Tell me you have it. I'll create a one-time link, `https://dream.omer.build/connect/claude?t=…`, valid for 15
   minutes.
3. Open the link and paste the token there. Dream encrypts it and puts it on every project's egress rules, so
   running sandboxes switch over too. Nothing is restarted.

**The old token:** connecting the new one replaces it in Dream. To revoke the old one at Anthropic, look under
claude.ai → **Settings** for authorized apps or sessions. I haven't verified where Anthropic lists `setup-token`
tokens; if it isn't listed separately, signing out everywhere revokes it, but signs you out of Claude elsewhere too.

**Tell me:** step 2.
