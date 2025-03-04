import * as path from 'path';
import { Template } from 'aws-cdk-lib/assertions';
import { Code, Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AssetHashType, DockerImage, Stack } from 'aws-cdk-lib';
import { PythonFunction } from '../lib';
import { Bundling, BundlingProps } from '../lib/bundling';

jest.mock('../lib/bundling', () => {
  return {
    Bundling: {
      bundle: jest.fn().mockImplementation((options: BundlingProps): Code => {
        const mockObjectKey = (() => {
          const hashType = options.assetHashType ?? (options.assetHash ? 'custom' : 'source');
          switch (hashType) {
            case 'source': return 'SOURCE_MOCK';
            case 'output': return 'OUTPUT_MOCK';
            case 'custom': {
              if (!options.assetHash) { throw new Error('no custom hash'); }
              return options.assetHash;
            }
          }

          throw new Error('unexpected asset hash type');
        })();

        return new class extends lambda.Code {
          public readonly isInline: boolean = false;
          public bind = () => ({
            s3Location: {
              bucketName: 'mock-bucket-name',
              objectKey: mockObjectKey,
            },
          });
        }();
      }),
      hasDependencies: jest.fn().mockReturnValue(false),
    },
  };
});

let stack: Stack;
beforeEach(() => {
  stack = new Stack();
  jest.clearAllMocks();
});

test('PythonFunction with defaults', () => {
  new PythonFunction(stack, 'handler', {
    entry: path.join(__dirname, 'lambda-handler'),
    runtime: Runtime.PYTHON_3_8,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    entry: expect.stringMatching(/aws-lambda-python-alpha\/test\/lambda-handler$/),
  }));

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'index.handler',
  });
});

test('PythonFunction with index in a subdirectory', () => {
  new PythonFunction(stack, 'handler', {
    entry: path.join(__dirname, 'lambda-handler-sub'),
    index: 'inner/custom_index.py',
    handler: 'custom_handler',
    runtime: Runtime.PYTHON_3_8,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    entry: expect.stringMatching(/aws-lambda-python-alpha\/test\/lambda-handler-sub$/),
  }));

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'inner.custom_index.custom_handler',
  });
});

test('PythonFunction with index in a nested subdirectory', () => {
  new PythonFunction(stack, 'handler', {
    entry: path.join(__dirname, 'lambda-handler-sub-nested'),
    index: 'inner/inner2/custom_index.py',
    handler: 'custom_handler',
    runtime: Runtime.PYTHON_3_8,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    entry: expect.stringMatching(/aws-lambda-python-alpha\/test\/lambda-handler-sub-nested$/),
  }));

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Handler: 'inner.inner2.custom_index.custom_handler',
  });
});

test('throws when index is not py', () => {
  expect(() => new PythonFunction(stack, 'Fn', {
    entry: path.join(__dirname, 'lambda-handler'),
    index: 'index.js',
    runtime: Runtime.PYTHON_3_8,
  })).toThrow(/Only Python \(\.py\) index files are supported/);
});

test('throws when entry does not exist', () => {
  expect(() => new PythonFunction(stack, 'Fn', {
    entry: 'notfound',
    runtime: Runtime.PYTHON_3_8,
  })).toThrow(/Cannot find index file at/);
});

test('throws with the wrong runtime family', () => {
  expect(() => new PythonFunction(stack, 'handler1', {
    entry: path.join(__dirname, 'lambda-handler'),
    runtime: lambda.Runtime.NODEJS_LATEST,
  })).toThrow(/Only `PYTHON` runtimes are supported/);
});

test('allows specifying hash type', () => {
  new PythonFunction(stack, 'source1', {
    entry: path.join(__dirname, 'lambda-handler-nodeps'),
    index: 'index.py',
    handler: 'handler',
    runtime: Runtime.PYTHON_3_8,
  });

  new PythonFunction(stack, 'source2', {
    entry: path.join(__dirname, 'lambda-handler-nodeps'),
    index: 'index.py',
    handler: 'handler',
    runtime: Runtime.PYTHON_3_8,
    bundling: { assetHashType: AssetHashType.SOURCE },
  });

  new PythonFunction(stack, 'output', {
    entry: path.join(__dirname, 'lambda-handler-nodeps'),
    index: 'index.py',
    handler: 'handler',
    runtime: Runtime.PYTHON_3_8,
    bundling: { assetHashType: AssetHashType.OUTPUT },
  });

  new PythonFunction(stack, 'custom', {
    entry: path.join(__dirname, 'lambda-handler-nodeps'),
    index: 'index.py',
    handler: 'handler',
    runtime: Runtime.PYTHON_3_8,
    bundling: { assetHash: 'MY_CUSTOM_HASH' },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: 'mock-bucket-name',
      S3Key: 'SOURCE_MOCK',
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: 'mock-bucket-name',
      S3Key: 'OUTPUT_MOCK',
    },
  });

  Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
    Code: {
      S3Bucket: 'mock-bucket-name',
      S3Key: 'MY_CUSTOM_HASH',
    },
  });
});

test('Allows use of custom bundling image', () => {
  const entry = path.join(__dirname, 'lambda-handler-custom-build');
  const image = DockerImage.fromBuild(path.join(entry));

  new PythonFunction(stack, 'function', {
    entry,
    runtime: Runtime.PYTHON_3_8,
    bundling: { image },
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    image,
  }));
});

test('Skip bundling when stack does not require it', () => {
  const spy = jest.spyOn(stack, 'bundlingRequired', 'get').mockReturnValue(false);
  const entry = path.join(__dirname, 'lambda-handler');

  new PythonFunction(stack, 'function', {
    entry,
    runtime: Runtime.PYTHON_3_8,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    skip: true,
  }));

  spy.mockRestore();
});

test('Do not skip bundling when stack requires it', () => {
  const spy = jest.spyOn(stack, 'bundlingRequired', 'get').mockReturnValue(true);
  const entry = path.join(__dirname, 'lambda-handler');

  new PythonFunction(stack, 'function', {
    entry,
    runtime: Runtime.PYTHON_3_8,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(expect.objectContaining({
    skip: false,
  }));

  spy.mockRestore();
});

test('PythonFunction specifying architecture', () => {
  new PythonFunction(stack, 'handler', {
    entry: path.join(__dirname, 'lambda-handler'),
    runtime: Runtime.PYTHON_3_11,
    architecture: Architecture.ARM_64,
  });

  expect(Bundling.bundle).toHaveBeenCalledWith(
    expect.objectContaining({
      architecture: Architecture.ARM_64,
    }),
  );
});
