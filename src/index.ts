import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import minimist from 'minimist';
import prompts from 'prompts';
import { red, reset } from 'kolorist';
import { Octokit } from 'octokit';

const octokit = new Octokit();

const argv = minimist<{
  t?: string
  template?: string
}>(process.argv.slice(2), { string: ['_'] });

const cwd = process.cwd();

const isEmpty = (path: string): boolean => {
  const files = fs.readdirSync(path);
  return files.length === 0 || (files.length === 1 && files[0] === '.git');
};

const formatTargetDir = (targetDir: string | undefined): string|undefined => {
  return targetDir?.trim().replace(/\/+$/g, '');
}

const isValidPackageName = (projectName: string): boolean => {
  return /^(?:@[a-z\d\-*~][a-z\d\-*._~]*\/)?[a-z\d\-~][a-z\d\-._~]*$/.test(
    projectName,
  )
};

const toValidPackageName = (projectName: string): string => {
  return projectName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]/, '')
    .replace(/[^a-z\d\-~]+/g, '-')
};

interface ITemplate {
  name: string;
  description: string | null;
  clone_url: string;
}

const fetchTemplateRepositories = async (): Promise<ITemplate[]> => {
  const templates: ITemplate[] = [];

  let hasMore: boolean = true;

  while (hasMore) {
    const response = await octokit.request('GET /search/repositories', {
      headers: {
        'X-GitHub-Api-Version': '2022-11-28'
      },
      q: 'template:true user:congnv0330'
    });

    const items: ITemplate[] = response.data.items.map((repo) => ({
      name: repo.name,
      description: repo.description,
      clone_url: repo.clone_url,
    }));

    templates.push(...items);

    hasMore = templates.length < response.data.total_count;
  }

  return templates;
}

const defaultTargetDir: string = 'my-project';

const init = async () => {
  const repoTemplates = await fetchTemplateRepositories();

  const argTargetDir = formatTargetDir(argv._[0]);

  const argTemplate = argv.template || argv.t;

  const isValidTemplate: boolean =
    !!argTemplate &&
    repoTemplates.some((template) => template.name === argTemplate);

  let targetDir = argTargetDir || defaultTargetDir;

  const getProjectName = () =>
    targetDir === '.' ? path.basename(path.resolve()) : targetDir;

  let result: prompts.Answers<'projectName' | 'packageName' | 'template' | 'overwrite'>;

  try {
    result = await prompts(
      [
        {
          type: 'text',
          name: 'projectName',
          message: reset('Project name:'),
          initial: defaultTargetDir,
          onState: (state) => {
            targetDir = formatTargetDir(state.value) || defaultTargetDir
          },
        },
        {
          type: () =>
            !fs.existsSync(targetDir) || isEmpty(targetDir) ? null : 'confirm',
          name: 'overwrite',
          message: () =>
            (targetDir === '.'
              ? 'Current directory'
              : `Target directory "${targetDir}"`) +
            ` is not empty. Remove existing files and continue?`,
        },
        {
          type: (_, { overwrite }: { overwrite?: boolean }) => {
            if (overwrite === false) {
              throw new Error(red('✖') + ' Operation cancelled')
            }
            return null
          },
          name: 'overwriteChecker',
        },
        {
          type: () => (isValidPackageName(getProjectName()) ? null : 'text'),
          name: 'packageName',
          message: reset('Package name:'),
          initial: () => toValidPackageName(getProjectName()),
          validate: (dir) =>
            isValidPackageName(dir) || 'Invalid package.json name',
        },
        {
          type: isValidTemplate ? null : 'select',
          name: 'template',
          message:
            typeof argTemplate === 'string' && !isValidTemplate
              ? reset(
                  `"${argTemplate}" isn't a valid template. Please choose from below: `,
                )
              : reset('Select a template:'),
          initial: 0,
          choices: repoTemplates.map((template) => {
            return {
              title: template.name,
              description: template.description ?? '...',
              value: template,
            }
          }),
        },
      ],
      {
        onCancel: () => {
          throw new Error(red('✖') + ' Operation cancelled')
        },
      },
    );
  } catch (e: any) {
    console.log(e.message);
    return;
  }

  const root = path.join(cwd, targetDir);

  const { template, overwrite, packageName } = result;

  if ((!overwrite || overwrite === true) && fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const selectedTemplete = template
    ? template
    : repoTemplates.find((template) => template.name === argTemplate);

  if (!selectedTemplete) {
    throw new Error(red('✖') + ' Something error. Template not available now.');
  }

  const write = (file: string, content: string): void => {
    const targetPath = path.join(root, file)
    fs.writeFileSync(targetPath, content);
  }

  console.log(`\nClone project template in ${root}...\n`);

  // Clone template repositories
  childProcess.exec(`git clone ${selectedTemplete.clone_url} ${targetDir}`, (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      return;
    }

    const pkgDir = path.join(root, `package.json`);

    // Rename package.json name if exists
    if (fs.existsSync(pkgDir)) {
      const pkg = JSON.parse(
        fs.readFileSync(pkgDir, 'utf-8'),
      );

      pkg.name = packageName || getProjectName();

      write('package.json', JSON.stringify(pkg, null, 2) + '\n');
    }

    // Clean
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'package-lock.json'), { force: true });
    fs.rmSync(path.join(root, 'yarn.lock'), { force: true });

    console.log(`Done.\n`);
  });
}

init().catch((e) => {
  console.error(e);
});
