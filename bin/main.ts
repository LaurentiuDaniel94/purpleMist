#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BaselineVPCInfrastructure } from '../lib/base-Infrastructure-stack';
import { EcrStack } from '../lib/image-repository-stack';
import { EcsStack } from '../lib/elastic-container-stack';
//
const app = new cdk.App();

// Create VPC Stack
const baselineVPCInfrastructure = new BaselineVPCInfrastructure(app, 'baselineVPCInfrastructure');

// Create ECR Stack
const ecrStack = new EcrStack(app, 'EcrStack');


// // Create ECS Stack
const ecsStack = new EcsStack(app, 'EcsStack', {
  vpc: baselineVPCInfrastructure.vpc,
  ecsSecurityGroup: baselineVPCInfrastructure.ecsSecurityGroup,
  albSecurityGroup: baselineVPCInfrastructure.albSecurityGroup,
  bedrockGatewaySecurityGroup: baselineVPCInfrastructure.bedrockGatewaySecurityGroup,
  repository: ecrStack.repository,
  alb: baselineVPCInfrastructure.alb,
  targetGroup: baselineVPCInfrastructure.targetGroup,
});

app.synth();