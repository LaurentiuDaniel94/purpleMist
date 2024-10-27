import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  repository: ecr.Repository;
  alb: elbv2.ApplicationLoadBalancer;
  targetGroup: elbv2.ApplicationTargetGroup;
}

export class EcsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: EcsStackProps) {
    super(scope, id, props);

    // Create roles
    const taskRole = new iam.Role(this, 'OpenWebUITaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, 'OpenWebUIExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add task role permissions for EFS
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess'
      ],
      resources: ['*']  // Will be restricted to specific EFS ARN later
    }));

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    // Service Discovery Namespace
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'OpenWebUINamespace', {
      vpc: props.vpc,
      name: 'openwebui.local',
      description: 'Service discovery namespace for OpenWebUI services',
    });

    // Create Security Group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EFSSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    // Allow NFS traffic from ECS Security Group to EFS
    efsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(2049),
      'Allow NFS access from ECS tasks'
    );

    // Create EFS File System
    const fileSystem = new efs.FileSystem(this, 'OpenWebUIEfs', {
      vpc: props.vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      encrypted: true,
      securityGroup: efsSecurityGroup,
      // Create mount targets in all private subnets
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true // Ensure one mount target per AZ
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });


    // Add dependency check to ensure mount targets are created before ECS service
    const mountTargetParam = new ssm.StringParameter(this, 'EfsMountTargetCheck', {
      parameterName: '/efs/mount-targets-check',
      stringValue: fileSystem.fileSystemId,
    });

    // Update task role permissions with specific EFS ARN
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess'
      ],
      resources: [fileSystem.fileSystemArn]
    }));

    // Create Access Point for EFS
    const accessPoint = fileSystem.addAccessPoint('AccessPoint', {
      path: '/data',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755'
      },
      posixUser: {
        uid: '1000',
        gid: '1000'
      },
    });

    // Task Definition for OpenWebUI
    const openWebUITaskDef = new ecs.FargateTaskDefinition(this, 'OpenWebUITask', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole: taskRole,
      executionRole: executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // Add permissions
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    // Add EFS permissions to execution role
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:DescribeMountTargets'
      ],
      resources: [fileSystem.fileSystemArn]
    }));

    // EFS Volume Configuration
    openWebUITaskDef.addVolume({
      name: 'WebUIEfsVolume',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
        rootDirectory: '/'
      },
    });

    // Container Definition for OpenWebUI
    const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'openwebui'),
      environment: {
        'WEBUI_SECRET_KEY': '123456',
        'DEBUG': 'true',
        'DATABASE_TYPE': 'sqlite',
        'DATABASE_PATH': '/app/backend/data/webui.db'
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'openwebui',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    openWebUIContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP
    });

    // Mount EFS to the container
    openWebUIContainer.addMountPoints({
      containerPath: '/app/backend/data',
      sourceVolume: 'WebUIEfsVolume',
      readOnly: false,
    });

    // Update ECS Service to depend on mount targets
    const openWebUIService = new ecs.FargateService(this, 'OpenWebUIService', {
      cluster,
      taskDefinition: openWebUITaskDef,
      desiredCount: 1,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'open-webui',
      },
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // Add dependency
    openWebUIService.node.addDependency(mountTargetParam);

    // Attach to ALB
    openWebUIService.attachToApplicationTargetGroup(props.targetGroup);

    // Output the File System ID
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fileSystem.fileSystemId,
      description: 'EFS File System ID',
      exportName: 'efsFileSystemId'
    });
  }
}