import type { ErrorObject } from "ajv";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  getRequestValidator,
  getResponseValidator,
  type SchemaName,
} from "../schema-registry";

export interface ValidationError {
  field: string;
  message: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: ValidationError[];
  };
}

function errorField(error: ErrorObject): string {
  const base = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  const property =
    error.keyword === "required"
      ? (error.params as { missingProperty?: string }).missingProperty
      : (error.params as { additionalProperty?: string }).additionalProperty;

  return [base, property].filter(Boolean).join(".");
}

export function validationErrorResponse(
  message: string,
  errors: ErrorObject[] | null | undefined,
  code = "VALIDATION_ERROR"
): ErrorResponse {
  return {
    error: {
      code,
      message,
      details: (errors ?? []).map((error) => ({
        field: errorField(error),
        message: error.message ?? "is invalid",
      })),
    },
  };
}

export function validateQuery(name: SchemaName): RequestHandler {
  const validator = getRequestValidator(name);

  return (req, res, next) => {
    const value = { ...req.query };
    if (!validator(value)) {
      return res
        .status(400)
        .json(validationErrorResponse("Invalid query parameters", validator.errors));
    }

    res.locals.validatedQuery = value;
    next();
  };
}

export function validateParams(name: SchemaName): RequestHandler {
  const validator = getRequestValidator(name);

  return (req, res, next) => {
    const value = { ...req.params };
    if (!validator(value)) {
      return res
        .status(400)
        .json(validationErrorResponse("Invalid path parameters", validator.errors));
    }

    res.locals.validatedParams = value;
    next();
  };
}

export function validateBody(name: SchemaName): RequestHandler {
  const validator = getRequestValidator(name);

  return (req, res, next) => {
    if (!validator(req.body)) {
      return res
        .status(400)
        .json(validationErrorResponse("Invalid request body", validator.errors));
    }

    res.locals.validatedBody = req.body;
    next();
  };
}

export function validateResponse(name: SchemaName): RequestHandler {
  const validator = getResponseValidator(name);

  return (_req, res, next) => {
    const sendJson = res.json.bind(res) as Response["json"];
    res.json = ((body: unknown) => {
      if (res.statusCode < 400 && !validator(body)) {
        res.status(500);
        return sendJson(
          validationErrorResponse(
            "Response validation failed",
            validator.errors,
            "RESPONSE_VALIDATION_ERROR"
          )
        );
      }

      return sendJson(body);
    }) as Response["json"];
    next();
  };
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error("Unhandled error:", err.message);
  const response: ErrorResponse = {
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  };
  res.status(500).json(response);
}
