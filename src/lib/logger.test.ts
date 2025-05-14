import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test";
import {
  buildLogPrefix,
  ConsoleLogger,
  MutableLogger,
  PrefixedLogger,
  type LogData,
  type LogDataInput,
  type Logger,
} from "./logger";

describe("Logger Utilities", () => {
  describe("buildLogPrefix", () => {
    it("should return an empty string if no task or stage is provided", () => {
      const data: LogData = { level: "info", message: "Test" };
      expect(buildLogPrefix(data)).toBe("");
    });

    it("should return a prefix with task if task is provided", () => {
      const data: LogData = {
        level: "info",
        task: "TestTask",
        message: "Test",
      };

      expect(buildLogPrefix(data)).toBe("[TestTask] ");
    });

    it("should return a prefix with stage if stage is provided", () => {
      const data: LogData = {
        level: "info",
        stage: "TestStage",
        message: "Test",
      };

      expect(buildLogPrefix(data)).toBe("[TestStage] ");
    });

    it("should return a prefix with task and stage if both are provided", () => {
      const data: LogData = {
        level: "info",
        task: "TestTask",
        stage: "TestStage",
        message: "Test",
      };

      expect(buildLogPrefix(data)).toBe("[TestTask] [TestStage] ");
    });
  });

  describe("ConsoleLogger", () => {
    let consoleLogMock: any;
    let consoleWarnMock: any;
    let consoleErrorMock: any;

    beforeEach(() => {
      // Spy on console methods and provide a mock implementation to prevent actual output
      consoleLogMock = spyOn(console, "log").mockImplementation(() => {});
      consoleWarnMock = spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorMock = spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
      // Restore the original console methods
      consoleLogMock.mockRestore();
      consoleWarnMock.mockRestore();
      consoleErrorMock.mockRestore();
    });

    it("should log info messages with prefix", () => {
      const logger = new ConsoleLogger();
      const logInput: LogDataInput = { task: "TaskA", message: "Info message" };
      logger.log(logInput);

      expect(consoleLogMock).toHaveBeenCalledWith("[TaskA] Info message");
    });

    it("should log warning messages with prefix", () => {
      const logger = new ConsoleLogger();
      const logInput: LogDataInput = {
        stage: "StageB",
        message: "Warning message",
      };

      logger.warn(logInput);

      expect(consoleWarnMock).toHaveBeenCalledWith("[StageB] Warning message");
    });

    it("should log error messages with prefix and error object", () => {
      const logger = new ConsoleLogger();
      const errorObj = new Error("Test error");
      const logInput: LogDataInput = {
        task: "TaskC",
        stage: "StageD",
        message: "Error message",
        error: errorObj,
      };

      logger.error(logInput);

      expect(consoleErrorMock).toHaveBeenCalledWith(
        "[TaskC] [StageD] Error message",
        errorObj,
      );
    });
  });

  describe("MutableLogger", () => {
    let baseLoggerMock: Logger;
    let logSpy: any;
    let warnSpy: any;
    let errorSpy: any;

    beforeEach(() => {
      logSpy = mock(() => {});
      warnSpy = mock(() => {});
      errorSpy = mock(() => {});
      baseLoggerMock = {
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      };
    });

    it("should log messages when verbose is true", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, true);
      const logInput: LogDataInput = { task: "MTask", message: "Verbose on" };
      mutableLogger.log(logInput);

      expect(logSpy).toHaveBeenCalledWith({
        ...logInput,
        message: "[MTask] Verbose on",
      });
    });

    it("should not log messages when verbose is false", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, false);
      mutableLogger.log({ message: "Verbose off" });

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("should call baseLogger.warn when verbose and warn is defined", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, true);
      const logInput: LogDataInput = { task: "MWarn", message: "Warn on" };
      mutableLogger.warn(logInput);

      expect(warnSpy).toHaveBeenCalledWith({
        ...logInput,
        message: "[MWarn] Warn on",
      });
    });

    it("should not call baseLogger.warn when verbose is false", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, false);
      mutableLogger.warn({ message: "Warn off" });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("should log errors when verbose is true", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, true);
      const errorObj = new Error("Mutable error");
      const logInput: LogDataInput = {
        task: "MError",
        message: "Error on",
        error: errorObj,
      };

      mutableLogger.error(logInput);

      expect(errorSpy).toHaveBeenCalledWith({
        ...logInput,
        message: "[MError] Error on",
        error: errorObj,
      });
    });

    it("should not log errors when verbose is false", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, false);
      mutableLogger.error({ message: "Error off" });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("setVerbose should toggle logging", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, false);
      mutableLogger.log({ message: "Initial" });
      expect(logSpy).not.toHaveBeenCalled();

      mutableLogger.setVerbose(true);
      const logInput: LogDataInput = { task: "MSet", message: "Now logging" };
      mutableLogger.log(logInput);
      expect(logSpy).toHaveBeenCalledWith({
        ...logInput,
        message: "[MSet] Now logging",
      });

      mutableLogger.setVerbose(false);
      logSpy.mockClear(); // Clear previous calls
      mutableLogger.log({ message: "Not logging again" });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it("isVerbose should return current state", () => {
      const mutableLogger = new MutableLogger(baseLoggerMock, true);
      expect(mutableLogger.isVerbose()).toBe(true);
      mutableLogger.setVerbose(false);
      expect(mutableLogger.isVerbose()).toBe(false);
    });
  });

  describe("PrefixedLogger", () => {
    let baseLoggerMock: Logger;
    let logSpy: any;
    let warnSpy: any;
    let errorSpy: any;

    beforeEach(() => {
      logSpy = mock(() => {});
      warnSpy = mock(() => {});
      errorSpy = mock(() => {});
      baseLoggerMock = {
        log: logSpy,
        warn: warnSpy,
        error: errorSpy,
      };
    });

    it("should add its prefix to log messages", () => {
      const prefixedLogger = new PrefixedLogger(baseLoggerMock, {
        task: "PTask",
      });

      prefixedLogger.log({ message: "Prefixed log" });

      expect(logSpy).toHaveBeenCalledWith({
        task: "PTask",
        message: "Prefixed log",
      });
    });

    it("should use original task/stage if provided in log data, overriding its own prefix", () => {
      const prefixedLogger = new PrefixedLogger(baseLoggerMock, {
        task: "PTask",
        stage: "PStage",
      });

      prefixedLogger.log({
        task: "OriginalTask",
        message: "Original task log",
      });

      expect(logSpy).toHaveBeenCalledWith({
        task: "OriginalTask",
        stage: "PStage",
        message: "Original task log",
      });

      logSpy.mockClear();
      prefixedLogger.log({
        stage: "OriginalStage",
        message: "Original stage log",
      });

      expect(logSpy).toHaveBeenCalledWith({
        task: "PTask",
        stage: "OriginalStage",
        message: "Original stage log",
      });
    });

    it("should add its prefix to warning messages", () => {
      const prefixedLogger = new PrefixedLogger(baseLoggerMock, {
        stage: "PStageW",
      });

      prefixedLogger.warn({ message: "Prefixed warn" });

      expect(warnSpy).toHaveBeenCalledWith({
        stage: "PStageW",
        message: "Prefixed warn",
      });
    });

    it("should add its prefix to error messages", () => {
      const prefixedLogger = new PrefixedLogger(baseLoggerMock, {
        task: "PTaskE",
        stage: "PStageE",
      });

      const errorObj = new Error("Prefixed error");
      prefixedLogger.error({ message: "Prefixed error msg", error: errorObj });

      expect(errorSpy).toHaveBeenCalledWith({
        task: "PTaskE",
        stage: "PStageE",
        message: "Prefixed error msg",
        error: errorObj,
      });
    });
  });
});
