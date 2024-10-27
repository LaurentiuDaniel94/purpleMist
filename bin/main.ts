#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BaselineVPCInfrastructure } from '../lib/base-Infrastructure-stack';
import { EcrStack } from '../lib/image-repository-stack';
import { DatabaseStack } from '../lib/postgres-db-stack';
import { EcsStack } from '../lib/elastic-container-stack';

const app = new cdk.App();

// Create VPC Stack
const baselineVPCInfrastructure = new BaselineVPCInfrastructure(app, 'VpcStack');

// Create ECR Stack
const ecrStack = new EcrStack(app, 'EcrStack');

// Create DB Stack
// const dbStack = new DatabaseStack(app, 'DatabaseStack', {
//   vpc: baselineVPCInfrastructure.vpc,
//   dbSecurityGroup: baselineVPCInfrastructure.dbSecurityGroup,
// });

// // Create ECS Stack
// const ecsStack = new EcsStack(app, 'EcsStack', {
//   vpc: baselineVPCInfrastructure.vpc,
//   dbInstance: dbStack.dbInstance,
//   ecsSecurityGroup: baselineVPCInfrastructure.ecsSecurityGroup,
//   albSecurityGroup: baselineVPCInfrastructure.albSecurityGroup,
//   repository: ecrStack.repository,
// });

// Add dependencies
// dbStack.addDependency(baselineVPCInfrastructure);
// ecsStack.addDependency(dbStack);
// ecsStack.addDependency(ecrStack);

app.synth();