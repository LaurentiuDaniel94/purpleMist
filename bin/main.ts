#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BaselineInfrastructure } from "../lib/base-Infrastructure-stack";

const app = new cdk.App();

// Create baseInfrastructure stack
new BaselineInfrastructure(app, "BaselineInfrastructure", {
    env: {
        region: "us-west-2"
    }
});