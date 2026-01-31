import { Box, Text } from "ink";
import { useMemo } from "react";
import type {
  ElicitRequestFormParams,
  ElicitRequestParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types";
import { InlineQuestionApproval } from "./InlineQuestionApproval";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

const SOLID_LINE = "─";

interface McpElicitationFlowProps {
  serverName: string;
  request: ElicitRequestParams;
  onSubmit: (result: ElicitResult) => void;
  onCancel: () => void;
}

interface QuestionOption {
  label: string;
  description: string;
}

type FieldSpec = {
  name: string;
  question: string;
  multiSelect: boolean;
  allowOther: boolean;
  options: QuestionOption[];
  valueByLabel: Map<string, string>;
  coerce: (value: string) => string | number | boolean | string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFormRequest(params: ElicitRequestParams): params is ElicitRequestFormParams {
  return !("mode" in params) || params.mode === "form";
}

function coerceBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["yes", "true", "1"].includes(normalized);
}

function coerceNumber(value: string, integer: boolean): string | number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return integer ? Math.trunc(parsed) : parsed;
}

export function McpElicitationFlow({
  serverName,
  request,
  onSubmit,
  onCancel,
}: McpElicitationFlowProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  const formParams = isFormRequest(request) ? request : null;

  const { questions, fieldsByQuestion } = useMemo(() => {
    const fields: FieldSpec[] = [];
    const fieldMap = new Map<string, FieldSpec>();

    if (!formParams) {
      return { questions: [], fieldsByQuestion: fieldMap };
    }

    const requestedSchema =
      typeof formParams.requestedSchema === "object"
        ? formParams.requestedSchema
        : undefined;
    const properties =
      requestedSchema &&
      isRecord(requestedSchema) &&
      isRecord(requestedSchema.properties)
        ? (requestedSchema.properties as Record<string, unknown>)
        : {};
    const requiredFields = new Set(
      Array.isArray(requestedSchema?.required)
        ? requestedSchema?.required
        : [],
    );

    for (const [name, rawSchema] of Object.entries(properties)) {
      if (!isRecord(rawSchema)) continue;
      const schema = rawSchema as Record<string, unknown>;
      const schemaType = typeof schema.type === "string" ? schema.type : null;
      const title =
        typeof schema.title === "string" ? schema.title : undefined;
      const description =
        typeof schema.description === "string" ? schema.description : undefined;

      const baseQuestion =
        title ??
        name.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
      const questionLabel = requiredFields.has(name)
        ? `${baseQuestion} *`
        : baseQuestion;

      const valueByLabel = new Map<string, string>();
      let options: QuestionOption[] = [];
      let multiSelect = false;
      let allowOther = true;

      const setOptionsFromEnum = (
        values: string[],
        labels?: string[],
      ): void => {
        options = values.map((value, index) => {
          const label = labels?.[index] || value;
          valueByLabel.set(label, value);
          return {
            label,
            description: label === value ? "" : value,
          };
        });
        allowOther = false;
      };

      if (schemaType === "boolean") {
        options = [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ];
        valueByLabel.set("Yes", "true");
        valueByLabel.set("No", "false");
        allowOther = false;
      } else if (schemaType === "string") {
        if (Array.isArray(schema.enum)) {
          const enumValues = schema.enum.filter(
            (value): value is string => typeof value === "string",
          );
          const enumNames = Array.isArray(schema.enumNames)
            ? schema.enumNames.filter(
                (value): value is string => typeof value === "string",
              )
            : undefined;
          setOptionsFromEnum(enumValues, enumNames);
        } else if (Array.isArray(schema.oneOf)) {
          const values: string[] = [];
          const labels: string[] = [];
          for (const option of schema.oneOf) {
            if (!isRecord(option)) continue;
            if (typeof option.const !== "string") continue;
            values.push(option.const);
            labels.push(
              typeof option.title === "string" ? option.title : option.const,
            );
          }
          setOptionsFromEnum(values, labels);
        }
      } else if (schemaType === "array" && isRecord(schema.items)) {
        multiSelect = true;
        const itemSchema = schema.items as Record<string, unknown>;
        if (Array.isArray(itemSchema.enum)) {
          const enumValues = itemSchema.enum.filter(
            (value): value is string => typeof value === "string",
          );
          setOptionsFromEnum(enumValues);
        } else if (Array.isArray(itemSchema.anyOf)) {
          const values: string[] = [];
          const labels: string[] = [];
          for (const option of itemSchema.anyOf) {
            if (!isRecord(option)) continue;
            if (typeof option.const !== "string") continue;
            values.push(option.const);
            labels.push(
              typeof option.title === "string" ? option.title : option.const,
            );
          }
          setOptionsFromEnum(values, labels);
        }
      }

      const coerce = (value: string) => {
        if (schemaType === "boolean") {
          return coerceBoolean(valueByLabel.get(value) ?? value);
        }
        if (schemaType === "number") {
          return coerceNumber(value, false);
        }
        if (schemaType === "integer") {
          return coerceNumber(value, true);
        }
        if (schemaType === "array") {
          const parts = value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean);
          return parts.map((part) => valueByLabel.get(part) ?? part);
        }
        return valueByLabel.get(value) ?? value;
      };

      fields.push({
        name,
        question: questionLabel,
        multiSelect,
        allowOther,
        options,
        valueByLabel,
        coerce,
      });
    }

    for (const field of fields) {
      let uniqueQuestion = field.question;
      if (fieldMap.has(uniqueQuestion)) {
        uniqueQuestion = `${field.question} (${field.name})`;
      }
      const spec = { ...field, question: uniqueQuestion };
      fieldMap.set(uniqueQuestion, spec);
    }

    const questions = Array.from(fieldMap.values()).map((field) => ({
      header: formParams?.message
        ? `[MCP:${serverName}] ${formParams.message}`
        : `[MCP:${serverName}] Requesting input`,
      question: field.question,
      options: field.options,
      multiSelect: field.multiSelect,
      allowOther: field.allowOther,
    }));

    return { questions, fieldsByQuestion: fieldMap };
  }, [formParams, serverName]);

  if (!formParams) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> MCP elicitation"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text color={colors.selector.title} bold>
          URL-based elicitation is not supported
        </Text>
        <Box height={1} />
        <Text dimColor>{"  "}Press Esc to cancel</Text>
      </Box>
    );
  }

  if (questions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{"> MCP elicitation"}</Text>
        <Text dimColor>{solidLine}</Text>
        <Box height={1} />
        <Text>{"  "}No fields requested by the server.</Text>
        <Box height={1} />
        <Text dimColor>{"  "}Press Esc to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{"> MCP elicitation"}</Text>
      <Text dimColor>{solidLine}</Text>
      <Box height={1} />
      <InlineQuestionApproval
        questions={questions}
        onCancel={onCancel}
        onSubmit={(answers) => {
          const content: Record<string, string | number | boolean | string[]> =
            {};
          for (const [question, answer] of Object.entries(answers)) {
            const field = fieldsByQuestion.get(question);
            if (!field) continue;
            content[field.name] = field.coerce(answer);
          }
          onSubmit({ action: "accept", content });
        }}
      />
    </Box>
  );
}
