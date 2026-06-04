module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        module: 'commonjs',
        target: 'ES2020',
        strict: false,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: false,
        resolveJsonModule: true,
        jsx: 'react',
        types: ['jest', 'node'],
        noImplicitAny: false,
      },
      diagnostics: {
        ignoreCodes: [2339, 7006, 2322, 2345, 2304, 2307, 2354, 2554],
        pretty: true,
      },
    }],
  },
  moduleNameMapper: {
    '^(.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/'],
};
