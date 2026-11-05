/**
 * What `dream` prints when it's invoked wrong. The agent reads it, so the
 * first line names the problem and the fix, then comes a working example and a
 * pointer to `--help`, never the whole help text, which buries the problem.
 */
import { Console, Layer, Option } from "effect"
import { type CliError, CliOutput, type HelpDoc } from "effect/cli"

/** "The API host …" → "the API host …", leaving "SF Symbol …" alone; no trailing period. */
const clause = (description: string) => {
  const text = description.trim().replace(/\.$/, "")
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text
}

const describe = (error: CliError.NonShowHelpErrors, doc: HelpDoc.HelpDoc): string => {
  switch (error._tag) {
    case "MissingOption": {
      const description = doc.flags.find((flag) => flag.name === error.option)?.description ?? Option.none()
      return Option.match(description, {
        onNone: () => `--${error.option} is missing.`,
        onSome: (text) => `--${error.option} is missing: ${clause(text)}.`
      })
    }
    case "MissingArgument": {
      const description = doc.args?.find((arg) => arg.name === error.argument)?.description ?? Option.none()
      return Option.match(description, {
        onNone: () => `<${error.argument}> is missing.`,
        onSome: (text) => `<${error.argument}> is missing: ${clause(text)}.`
      })
    }
    default:
      return error.message.trim()
  }
}

/** The text for an invalid invocation: one line per problem, an example, the usage, and where help is. */
export const invalidInvocation = (event: CliOutput.Presenter.InvalidInvocation): string => {
  const command = event.commandPath.join(" ")
  const example = event.helpDoc.examples?.[0]
  return [
    ...event.errors.map((error) => describe(error, event.helpDoc)),
    ...(example === undefined ? [] : [`Example: ${example.command}`]),
    `Usage: ${event.helpDoc.usage}. All flags: \`${command} --help\`.`
  ].join("\n")
}

/** Errors from a command's own checks (`CliError.UserError`) print as their message alone. */
const formatter: CliOutput.Formatter = {
  ...CliOutput.defaultFormatter(),
  formatError: (error) => error.message,
  formatErrors: (errors) => errors.map((error) => error.message).join("\n")
}

export const presenter: CliOutput.Presenter = {
  present: (event) =>
    event._tag === "InvalidInvocation"
      ? Console.error(invalidInvocation(event))
      : CliOutput.defaultPresenter.present(event)
}

export const layer = Layer.mergeAll(CliOutput.layer(formatter), CliOutput.layerPresenter(presenter))
